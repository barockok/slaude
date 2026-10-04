import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { VaultConfig } from "../../src/secrets/config";
import { SecretResolutionError, TRANSIENT_REASONS } from "../../src/secrets/errors";
import { createVaultClient } from "../../src/secrets/vault";
import { startFakeVault, type FakeVault } from "./fake-vault";

let fv: FakeVault;
let t: number;
const now = () => t;

beforeEach(() => {
  fv = startFakeVault();
  fv.secrets.set("secret/data/slaude/personas/a", { api_key: "fake-key-a", n: 7 });
  t = 1_000_000;
});
afterEach(() => fv.stop());

function cfg(over: Partial<VaultConfig> = {}): VaultConfig {
  return {
    addr: fv.addr,
    auth: "kubernetes",
    role: "slaude-gateway",
    jwtPath: "/fake/jwt",
    cacheTtlMs: 60_000,
    staleMaxMs: 600_000,
    mounts: ["secret"],
    prefixes: [{ mount: "secret", pathPrefix: "slaude/personas/{persona}" }],
    ...over,
  };
}

function client(over: Partial<VaultConfig> = {}, deps: Parameters<typeof createVaultClient>[1] = {}) {
  const jwtReads: string[] = [];
  const c = createVaultClient(cfg(over), {
    now,
    readFile: async (p) => {
      jwtReads.push(p);
      return "fake-sa-jwt\n";
    },
    minLoginIntervalMs: 30_000,
    ...deps,
  });
  return Object.assign(c, { jwtReads });
}

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SecretResolutionError) return e.reason;
    throw e;
  }
  throw new Error("expected a rejection");
}

describe("Vault client — login", () => {
  test("Kubernetes login with the service-account JWT, then a KV v2 read", async () => {
    const c = client();
    expect(await c.read("secret", "slaude/personas/a", "api_key")).toBe("fake-key-a");
    expect(fv.counts.login).toBe(1);
    expect(fv.lastLogin).toEqual({ role: "slaude-gateway", jwt: "fake-sa-jwt" });
    expect(c.jwtReads).toEqual(["/fake/jwt"]);
    // the token is kept in memory: a second read does not log in again
    await c.read("secret", "slaude/personas/a", "api_key");
    expect(fv.counts.login).toBe(1);
  });

  test("token auth presents the static token and never logs in", async () => {
    fv.live.add("fake-dev-token");
    const c = client({ auth: "token", token: "fake-dev-token", role: undefined });
    expect(await c.read("secret", "slaude/personas/a", "api_key")).toBe("fake-key-a");
    expect(fv.counts.login).toBe(0);
    expect(fv.kvTokens).toEqual(["fake-dev-token"]);
  });

  test("a refused login is an auth failure", async () => {
    fv.loginStatus = 400;
    expect(await reason(client().read("secret", "slaude/personas/a", "api_key"))).toBe("auth");
  });

  test("an unreadable JWT file is an auth failure", async () => {
    const c = client({}, {
      readFile: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(await reason(c.read("secret", "slaude/personas/a", "api_key"))).toBe("auth");
    expect(fv.counts.login).toBe(0);
  });

  test("renews before the lease ends instead of logging in again", async () => {
    fv.leaseSeconds = 30;
    const c = client();
    await c.read("secret", "slaude/personas/a", "api_key");
    t += 25_000; // past two thirds of the lease, before its end
    await c.read("secret", "slaude/personas/a", "api_key");
    expect(fv.counts.renew).toBe(1);
    expect(fv.counts.login).toBe(1);
  });

  test("past the lease end it logs in again (no renew of a dead token)", async () => {
    fv.leaseSeconds = 30;
    const c = client();
    await c.read("secret", "slaude/personas/a", "api_key");
    t += 31_000;
    await c.read("secret", "slaude/personas/a", "api_key");
    expect(fv.counts.renew).toBe(0);
    expect(fv.counts.login).toBe(2);
  });
});

describe("Vault client — 403 handling", () => {
  test("token expiry: lookup-self fails, then exactly ONE re-login for many concurrent reads", async () => {
    const c = client();
    await c.read("secret", "slaude/personas/a", "api_key");
    t += 60_000; // past the minimum login interval
    fv.live.clear(); // Vault revoked/expired the token early
    const out = await Promise.all(
      Array.from({ length: 20 }, () => c.read("secret", "slaude/personas/a", "api_key")),
    );
    expect(out.every((v) => v === "fake-key-a")).toBe(true);
    expect(fv.counts.login).toBe(2);
    // one capability probe per login, plus ONE lookup for all 20 concurrent 403s
    expect(fv.counts.lookup).toBe(3);
  });

  test("a revoked token on a role that can look itself up recovers at once via one login", async () => {
    const c = client();
    expect(await c.read("secret", "slaude/personas/a", "api_key")).toBe("fake-key-a");
    fv.live.clear();
    t += 100; // well inside the minimum login interval
    expect(await c.read("secret", "slaude/personas/a", "api_key")).toBe("fake-key-a");
    expect(fv.counts.login).toBe(2);
  });

  test("re-login is rate limited: at most two attempts per interval, then the login's own reason", async () => {
    const c = client();
    await c.read("secret", "slaude/personas/a", "api_key");
    t += 60_000;
    fv.live.clear();
    await c.read("secret", "slaude/personas/a", "api_key");
    expect(fv.counts.login).toBe(2);
    t += 1_000;
    fv.live.clear();
    await c.read("secret", "slaude/personas/a", "api_key");
    expect(fv.counts.login).toBe(3);
    t += 1_000;
    fv.live.clear();
    // two attempts in the window already: no login; the token is proven dead, so
    // the rate-limited login's transient reason is passed on (stale may apply)
    expect(await reason(c.read("secret", "slaude/personas/a", "api_key"))).toBe("auth");
    expect(fv.counts.login).toBe(3);
    t += 30_000;
    expect(await c.read("secret", "slaude/personas/a", "api_key")).toBe("fake-key-a");
    expect(fv.counts.login).toBe(4);
  });

  test("a policy denial does not cause a login storm (50 concurrent denied reads)", async () => {
    fv.secrets.set("secret/data/slaude/personas/b", { api_key: "fake-key-b" });
    fv.denied.add("secret/data/slaude/personas/b");
    const c = client();
    await c.read("secret", "slaude/personas/a", "api_key");
    t += 120_000; // well past the minimum interval: only the logic can prevent logins
    const reasons = await Promise.all(
      Array.from({ length: 50 }, () => reason(c.read("secret", "slaude/personas/b", "api_key"))),
    );
    expect(new Set(reasons)).toEqual(new Set(["denied"]));
    expect(fv.counts.login).toBe(1);
    // and sequential denials do not log in either
    for (let i = 0; i < 5; i++) await reason(c.read("secret", "slaude/personas/b", "api_key"));
    expect(fv.counts.login).toBe(1);
  });
});

describe("Vault client — a good token is never thrown away", () => {
  beforeEach(() => {
    fv.secrets.set("secret/data/slaude/personas/bob", { api_key: "fake-key-b" });
    fv.denied.add("secret/data/slaude/personas/bob");
  });

  test("lookup-self itself 403s (role without the default policy): one denial does not cause an outage", async () => {
    fv.lookupStatus = 403;
    const c = client();
    expect(await c.read("secret", "slaude/personas/a", "api_key")).toBe("fake-key-a");
    t += 1_000;
    expect(await reason(c.read("secret", "slaude/personas/bob", "api_key"))).toBe("denied");
    for (const step of [1_000, 4_000, 5_000, 5_000, 5_000, 5_000]) {
      t += step;
      expect(await c.read("secret", "slaude/personas/a", "api_key")).toBe("fake-key-a");
      expect(await reason(c.read("secret", "slaude/personas/bob", "api_key"))).toBe("denied");
    }
    expect(fv.counts.login).toBe(1);
    expect(fv.counts.lookup).toBe(1);
  });

  test("a proven-dead token whose replacement login fails passes on the login's reason and keeps the old token", async () => {
    const c = client();
    await c.read("secret", "slaude/personas/a", "api_key");
    t += 60_000;
    fv.live.clear();
    fv.loginStatus = 503;
    expect(await reason(c.read("secret", "slaude/personas/a", "api_key"))).toBe("server_error");
    expect(fv.counts.login).toBe(2);
    // Vault comes back and re-validates the old token: no login needed, it is still used
    fv.loginStatus = undefined;
    fv.live.add("fake-token-1");
    t += 1_000;
    expect(await c.read("secret", "slaude/personas/a", "api_key")).toBe("fake-key-a");
    expect(fv.kvTokens.at(-1)).toBe("fake-token-1");
    expect(fv.counts.login).toBe(2);
  });

  test("renew fails and login fails, but the lease is still running: the current token keeps working", async () => {
    fv.leaseSeconds = 90;
    const c = client();
    await c.read("secret", "slaude/personas/a", "api_key");
    t += 61_000; // past the renew point (60 s), before the lease end (90 s)
    fv.renewStatus = 503;
    fv.loginStatus = 503;
    expect(await c.read("secret", "slaude/personas/a", "api_key")).toBe("fake-key-a");
    t += 1_000;
    expect(await c.read("secret", "slaude/personas/a", "api_key")).toBe("fake-key-a");
    t += 1_000;
    expect(await c.read("secret", "slaude/personas/a", "api_key")).toBe("fake-key-a");
    expect(fv.kvTokens.every((x) => x === "fake-token-1")).toBe(true);
    // renew: one attempt per interval; login: at most two per interval
    expect(fv.counts.renew).toBe(1);
    expect(fv.counts.login).toBe(3);
  });

  test("a renew that returns lease 0 forces a login (lease 0 = never expires only on login)", async () => {
    fv.leaseSeconds = 90;
    fv.renewLeaseSeconds = 0;
    const c = client();
    await c.read("secret", "slaude/personas/a", "api_key");
    t += 61_000;
    await c.read("secret", "slaude/personas/a", "api_key");
    expect(fv.counts.renew).toBe(1);
    expect(fv.counts.login).toBe(2);
  });

  test("a Kubernetes login with a zero or negative lease is a bad response, not 'never expires'", async () => {
    for (const lease of [0, -5]) {
      fv.leaseSeconds = lease;
      expect(await reason(client().read("secret", "slaude/personas/a", "api_key"))).toBe("bad_response");
    }
  });

  test("a tiny positive lease cannot cause a login storm", async () => {
    fv.leaseSeconds = 0.0001;
    const c = client();
    await c.read("secret", "slaude/personas/a", "api_key");
    for (let i = 0; i < 20; i++) {
      t += 1_000;
      await c.read("secret", "slaude/personas/a", "api_key").catch(() => {});
    }
    expect(fv.counts.login).toBe(2);
    expect(fv.counts.renew).toBe(0);
  });

  test("a clock that jumps backwards does not block login or keep a token alive", async () => {
    fv.leaseSeconds = 30;
    const c = client();
    await c.read("secret", "slaude/personas/a", "api_key");
    t -= 3_600_000; // wall clock stepped back an hour
    // the token's age is unknown, so it is refreshed rather than trusted for another hour
    await c.read("secret", "slaude/personas/a", "api_key");
    expect(fv.counts.renew + fv.counts.login).toBe(2);
    // and a login is not blocked for an hour by a "future" last attempt
    fv.live.clear();
    fv.renewStatus = 403;
    t += 31_000;
    expect(await c.read("secret", "slaude/personas/a", "api_key")).toBe("fake-key-a");
  });
});

describe("Vault client — KV parsing", () => {
  test("missing secret", async () => {
    expect(await reason(client().read("secret", "slaude/personas/none", "api_key"))).toBe("missing_secret");
  });

  test("a deleted latest version is a missing secret", async () => {
    fv.secrets.set("secret/data/slaude/personas/gone", null);
    expect(await reason(client().read("secret", "slaude/personas/gone", "api_key"))).toBe("missing_secret");
  });

  test("missing field", async () => {
    expect(await reason(client().read("secret", "slaude/personas/a", "nope"))).toBe("missing_field");
  });

  test("non-string field", async () => {
    expect(await reason(client().read("secret", "slaude/personas/a", "n"))).toBe("non_string");
  });

  test("KV v1 mount (no data.data) is detected", async () => {
    fv.secrets.set("secret/data/slaude/personas/v1", "v1");
    expect(await reason(client().read("secret", "slaude/personas/v1", "api_key"))).toBe("kv_v1");
  });

  test("namespace header is sent on login, lookup and reads", async () => {
    fv.denied.add("secret/data/slaude/personas/a");
    const c = client({ namespace: "team-a" });
    await reason(c.read("secret", "slaude/personas/a", "api_key"));
    expect(fv.namespaces.map((x) => x.kind)).toEqual(["login", "lookup", "kv", "lookup"]);
    expect(fv.namespaces.every((x) => x.ns === "team-a")).toBe(true);
  });

  test("no namespace header when not configured", async () => {
    await client().read("secret", "slaude/personas/a", "api_key");
    expect(fv.namespaces.every((x) => x.ns === null)).toBe(true);
  });
});

describe("Vault client — transport failures", () => {
  test("5xx is server_error", async () => {
    const c = client();
    fv.kvStatus = 503;
    expect(await reason(c.read("secret", "slaude/personas/a", "api_key"))).toBe("server_error");
  });

  test("timeout", async () => {
    fv.kvDelayMs = 300;
    const c = client({}, { requestTimeoutMs: 50 });
    expect(await reason(c.read("secret", "slaude/personas/a", "api_key"))).toBe("timeout");
  });

  test("a timeout while the body is still arriving is a timeout, not a bad response", async () => {
    fv.kvBodyStallMs = 300;
    const c = client({}, { requestTimeoutMs: 80 });
    expect(await reason(c.read("secret", "slaude/personas/a", "api_key"))).toBe("timeout");
  });

  test("redirects are not followed: another host never receives the token", async () => {
    const other = startFakeVault();
    try {
      other.live.add("fake-token-1");
      fv.kvRedirect = `${other.addr}/v1/secret/data/slaude/personas/a`;
      expect(await reason(client().read("secret", "slaude/personas/a", "api_key"))).toBe("unreachable");
      expect(other.counts.kv).toBe(0);
      expect(other.kvTokens).toEqual([]);
    } finally {
      other.stop();
    }
  });

  test("the CA bundle is read from SLAUDE_VAULT_CACERT; an unreadable one fails closed", async () => {
    const read: string[] = [];
    const ok = createVaultClient(cfg({ caCertPath: "/fake/ca.pem" }), {
      now,
      readFile: async (p) => {
        read.push(p);
        return p === "/fake/ca.pem" ? "fake-ca-pem" : "fake-sa-jwt";
      },
    });
    await ok.read("secret", "slaude/personas/a", "api_key").catch(() => {});
    expect(read).toContain("/fake/ca.pem");
    const bad = createVaultClient(cfg({ caCertPath: "/fake/missing.pem" }), {
      now,
      readFile: async (p) => {
        if (p.endsWith(".pem")) throw new Error("ENOENT");
        return "fake-sa-jwt";
      },
    });
    expect(await reason(bad.read("secret", "slaude/personas/a", "api_key"))).toBe("unreachable");
    expect(fv.counts.login).toBe(1); // only the first client got as far as a request
  });

  test("which reasons are transient (may serve a stale value)", () => {
    expect([...TRANSIENT_REASONS].sort()).toEqual(["auth", "bad_response", "server_error", "timeout", "unreachable"]);
  });

  test("unreachable", async () => {
    const addr = fv.addr;
    fv.stop();
    const c = createVaultClient(cfg({ addr }), { now, readFile: async () => "fake-sa-jwt" });
    expect(await reason(c.read("secret", "slaude/personas/a", "api_key"))).toBe("unreachable");
  });

  test("an injected fetch is used, and error messages never carry the value", async () => {
    const seen: string[] = [];
    const c = client({}, {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push(String(input));
        return fetch(input, init);
      }) as typeof fetch,
    });
    try {
      await c.read("secret", "slaude/personas/a", "n");
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("fake-key-a");
    }
    expect(seen.some((u) => u.endsWith("/v1/secret/data/slaude/personas/a"))).toBe(true);
  });
});
