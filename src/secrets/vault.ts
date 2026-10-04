/**
 * Vault client (WS-A §6.1, §6.4): Kubernetes login, token renewal, KV v2 read.
 * The only place in slaude that knows Vault's HTTP shape.
 *
 * Token. Kubernetes auth logs in with the pod's service-account JWT; the
 * client token lives in memory only and is renewed (renew-self) once two
 * thirds of its lease has passed, lazily on the next read. Past the lease end
 * it logs in again.
 *
 * 403. Vault answers 403 both for "policy denies this path" and for "this
 * token is no longer valid". A 403 alone never triggers a login: the client
 * asks lookup-self first (single flight per token) and logs in again only if
 * the token itself is dead, then retries the read once. Logins are single
 * flight AND rate limited (one attempt per minimum interval), so a
 * policy-denied path — or a flapping Vault — cannot cause a login per resolve.
 *
 * Values, tokens and the JWT are never logged or put in an error message.
 */
import { SecretResolutionError, type SecretFailureReason } from "./errors";
import type { VaultConfig } from "./config";

export type VaultClient = {
  read(mount: string, path: string, field: string): Promise<string>;
};

export type VaultClientDeps = {
  fetch?: typeof fetch;
  now?: () => number;
  /** reads the JWT and CA files; default Bun.file(...).text() */
  readFile?: (path: string) => Promise<string>;
  /** per-request timeout; default 5s */
  requestTimeoutMs?: number;
  /** minimum time between two login attempts; default 30s */
  minLoginIntervalMs?: number;
};

type TokenState = { token: string; renewAt: number; expiresAt: number; renewable: boolean };

const fail = (reason: SecretFailureReason, message: string): never => {
  throw new SecretResolutionError(reason, message);
};

export function createVaultClient(cfg: VaultConfig, deps: VaultClientDeps = {}): VaultClient {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const readFile = deps.readFile ?? ((p: string) => Bun.file(p).text());
  const timeoutMs = deps.requestTimeoutMs ?? 5_000;
  const minLoginIntervalMs = deps.minLoginIntervalMs ?? 30_000;

  let state: TokenState | undefined =
    cfg.auth === "token" && cfg.token
      ? { token: cfg.token, renewAt: Infinity, expiresAt: Infinity, renewable: false }
      : undefined;
  let loginInflight: Promise<TokenState> | undefined;
  let renewInflight: Promise<TokenState> | undefined;
  let lastLoginAttemptAt: number | undefined;
  const lookupInflight = new Map<string, Promise<boolean>>();
  /** the last token lookup-self declared dead, so late 403s on it skip the lookup */
  let deadToken: string | undefined;
  let caPromise: Promise<string> | undefined;

  async function request(method: "GET" | "POST", path: string, token?: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {};
    if (token) headers["X-Vault-Token"] = token;
    if (cfg.namespace) headers["X-Vault-Namespace"] = cfg.namespace;
    if (body !== undefined) headers["content-type"] = "application/json";
    const init: RequestInit & { tls?: { ca: string } } = {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    };
    if (cfg.caCertPath) {
      caPromise ??= readFile(cfg.caCertPath);
      try {
        init.tls = { ca: await caPromise };
      } catch {
        caPromise = undefined;
        fail("unreachable", "Vault CA bundle (SLAUDE_VAULT_CACERT) is unreadable");
      }
    }
    try {
      return await doFetch(`${cfg.addr}/v1/${path}`, init);
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") return fail("timeout", "Vault did not answer in time");
      return fail("unreachable", "Vault is unreachable");
    }
  }

  async function json(res: Response): Promise<Record<string, unknown>> {
    try {
      const v = (await res.json()) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* fall through */
    }
    return fail("bad_response", `Vault answered ${res.status} with an unreadable body`);
  }

  /** Map a non-2xx status on login/renew to a reason. */
  function authStatusFailure(res: Response, what: string): never {
    void res.body?.cancel();
    if (res.status >= 500) return fail("server_error", `Vault ${what} failed with ${res.status}`);
    return fail("auth", `Vault ${what} was refused (${res.status})`);
  }

  function tokenFrom(body: Record<string, unknown>, what: string): TokenState {
    const auth = body.auth as { client_token?: unknown; lease_duration?: unknown; renewable?: unknown } | undefined;
    if (!auth || typeof auth.client_token !== "string" || auth.client_token === "") {
      return fail("bad_response", `Vault ${what} returned no client token`);
    }
    const lease = typeof auth.lease_duration === "number" && auth.lease_duration > 0 ? auth.lease_duration : 0;
    const t = now();
    return {
      token: auth.client_token,
      // lease 0 = a token that does not expire (root/dev tokens)
      expiresAt: lease ? t + lease * 1000 : Infinity,
      renewAt: lease ? t + Math.floor((lease * 1000 * 2) / 3) : Infinity,
      renewable: auth.renewable === true,
    };
  }

  function login(): Promise<TokenState> {
    if (loginInflight) return loginInflight;
    if (cfg.auth === "token") return Promise.reject(new SecretResolutionError("auth", "Vault token is not valid"));
    const t = now();
    if (lastLoginAttemptAt !== undefined && t - lastLoginAttemptAt < minLoginIntervalMs) {
      return Promise.reject(new SecretResolutionError("auth", "Vault login is rate limited"));
    }
    lastLoginAttemptAt = t;
    loginInflight = (async () => {
      let jwt: string;
      try {
        jwt = (await readFile(cfg.jwtPath)).trim();
      } catch {
        return fail("auth", "service-account token file is unreadable");
      }
      if (!jwt) return fail("auth", "service-account token file is empty");
      const res = await request("POST", "auth/kubernetes/login", undefined, { role: cfg.role, jwt });
      if (!res.ok) authStatusFailure(res, "login");
      state = tokenFrom(await json(res), "login");
      return state;
    })().finally(() => {
      loginInflight = undefined;
    });
    return loginInflight;
  }

  function renew(current: TokenState): Promise<TokenState> {
    renewInflight ??= (async () => {
      const res = await request("POST", "auth/token/renew-self", current.token, {});
      if (!res.ok) authStatusFailure(res, "renew");
      const renewed = tokenFrom(await json(res), "renew");
      state = renewed;
      return renewed;
    })().finally(() => {
      renewInflight = undefined;
    });
    return renewInflight;
  }

  async function currentToken(): Promise<string> {
    const s = state;
    const t = now();
    if (s && t < s.renewAt) return s.token;
    if (s && s.renewable && t < s.expiresAt) {
      try {
        return (await renew(s)).token;
      } catch {
        // fall through to a (rate-limited) login
      }
    }
    return (await login()).token;
  }

  /** true = the token is valid; false = it is not; throws if Vault cannot say. */
  function lookupSelf(token: string): Promise<boolean> {
    if (token === deadToken) return Promise.resolve(false);
    let p = lookupInflight.get(token);
    if (!p) {
      p = (async () => {
        const res = await request("GET", "auth/token/lookup-self", token);
        void res.body?.cancel();
        if (res.ok) return true;
        if (res.status === 401 || res.status === 403) {
          deadToken = token;
          return false;
        }
        if (res.status >= 500) return fail("server_error", `Vault lookup-self failed with ${res.status}`);
        return fail("bad_response", `Vault lookup-self answered ${res.status}`);
      })().finally(() => lookupInflight.delete(token));
      lookupInflight.set(token, p);
    }
    return p;
  }

  /** Replace a token Vault rejected. If another caller already did, use theirs. */
  async function replaceToken(dead: string): Promise<string> {
    if (state && state.token !== dead) return state.token;
    if (state?.token === dead && cfg.auth !== "token") state = undefined;
    return (await login()).token;
  }

  function parseKv(body: Record<string, unknown>, field: string): string {
    const data = body.data;
    if (!data || typeof data !== "object") return fail("bad_response", "Vault KV answer has no data");
    const d = data as Record<string, unknown>;
    if (!("data" in d) || !("metadata" in d)) return fail("kv_v1", "mount is not KV v2 (no data.data)");
    if (d.data === null) return fail("missing_secret", "secret version is deleted or destroyed");
    if (typeof d.data !== "object") return fail("bad_response", "Vault KV data.data is not an object");
    const value = (d.data as Record<string, unknown>)[field];
    if (value === undefined) return fail("missing_field", "secret has no such field");
    if (typeof value !== "string") return fail("non_string", "secret field is not a string");
    return value;
  }

  async function kvGet(apiPath: string, token: string): Promise<Response> {
    return request("GET", apiPath, token);
  }

  async function finish(res: Response, field: string): Promise<string> {
    if (res.status === 404) {
      void res.body?.cancel();
      return fail("missing_secret", "no secret at the referenced path");
    }
    if (res.status === 401 || res.status === 403) {
      void res.body?.cancel();
      return fail("denied", "Vault policy denies the referenced path");
    }
    if (res.status >= 500) {
      void res.body?.cancel();
      return fail("server_error", `Vault answered ${res.status}`);
    }
    if (!res.ok) {
      void res.body?.cancel();
      return fail("bad_response", `Vault answered ${res.status}`);
    }
    return parseKv(await json(res), field);
  }

  return {
    async read(mount, path, field) {
      const apiPath = `${mount}/data/${path}`;
      let token = await currentToken();
      let res = await kvGet(apiPath, token);
      if (res.status === 401 || res.status === 403) {
        void res.body?.cancel();
        if (await lookupSelf(token)) return fail("denied", "Vault policy denies the referenced path");
        token = await replaceToken(token);
        res = await kvGet(apiPath, token);
      }
      return finish(res, field);
    },
  };
}
