/**
 * Vault backend configuration (WS-A §6.1), gateway only.
 *
 *   SLAUDE_VAULT_ADDR              base URL; setting it enables the backend
 *   SLAUDE_VAULT_AUTH              kubernetes (default) | token (development only)
 *   SLAUDE_VAULT_ROLE              Kubernetes auth role (required for kubernetes)
 *   SLAUDE_VAULT_TOKEN             static token (required for token auth)
 *   SLAUDE_VAULT_ALLOWED_PREFIXES  comma list of <mount>/<path-prefix> — REQUIRED
 *   SLAUDE_VAULT_MOUNTS            comma list of KV v2 mounts (one or more
 *                                  segments each); default: the first segment
 *                                  of every allowed prefix
 *   SLAUDE_VAULT_NAMESPACE         sent as X-Vault-Namespace when set
 *   SLAUDE_VAULT_CACERT            CA bundle path for a private Vault
 *   SLAUDE_VAULT_CACHE_TTL         seconds; default 60; 0 = no cache
 *   SLAUDE_VAULT_STALE_MAX         seconds a failed refresh may serve the last value; default 600
 *   SLAUDE_VAULT_K8S_TOKEN_PATH    service-account JWT path (default the in-pod path)
 *   SLAUDE_VAULT_ALLOW_INSECURE    1 = development: allow http:// and token auth
 *
 * Every name starts with SLAUDE_VAULT_, which the child-env scrub strips.
 */
import { parseAllowedPrefixes, VaultConfigError, type AllowedPrefix } from "./allowlist";
import { checkVaultPath } from "./ref";

export { VaultConfigError };

export const DEFAULT_K8S_JWT_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";

export type VaultConfig = {
  addr: string;
  auth: "kubernetes" | "token";
  role?: string;
  token?: string;
  namespace?: string;
  caCertPath?: string;
  jwtPath: string;
  cacheTtlMs: number;
  staleMaxMs: number;
  mounts: string[];
  prefixes: AllowedPrefix[];
};

type Env = Record<string, string | undefined>;

function trimmed(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

/** A value that goes into a header or a login body: printable ASCII, no whitespace or control characters. */
function headerSafe(env: Env, name: string): string | undefined {
  const v = trimmed(env, name);
  if (v !== undefined && !/^[\x21-\x7e]+$/.test(v)) {
    throw new VaultConfigError(`${name} must be printable ASCII with no whitespace or control characters`);
  }
  return v;
}

function seconds(env: Env, name: string, dflt: number): number {
  const raw = trimmed(env, name);
  if (raw === undefined) return dflt * 1000;
  if (!/^\d+$/.test(raw)) throw new VaultConfigError(`${name} must be a whole number of seconds`);
  return Number(raw) * 1000;
}

/** Null when SLAUDE_VAULT_ADDR is unset (backend disabled). Throws on any misconfiguration. */
export function loadVaultConfig(env: Env): VaultConfig | null {
  const rawAddr = trimmed(env, "SLAUDE_VAULT_ADDR");
  if (!rawAddr) return null;
  let url: URL;
  try {
    url = new URL(rawAddr);
  } catch {
    throw new VaultConfigError("SLAUDE_VAULT_ADDR must be an http(s) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new VaultConfigError("SLAUDE_VAULT_ADDR must be an http(s) URL");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new VaultConfigError("SLAUDE_VAULT_ADDR must be a bare origin (no credentials, path or query)");
  }
  // Development only: plain http (the service-account JWT and the Vault token
  // would cross the network in cleartext) and static-token auth.
  const insecure = trimmed(env, "SLAUDE_VAULT_ALLOW_INSECURE") === "1";
  if (url.protocol === "http:" && !insecure) {
    throw new VaultConfigError(
      "SLAUDE_VAULT_ADDR must be https; plain http is for development only (set SLAUDE_VAULT_ALLOW_INSECURE=1)",
    );
  }

  const authRaw = (trimmed(env, "SLAUDE_VAULT_AUTH") ?? "kubernetes").toLowerCase();
  if (authRaw !== "kubernetes" && authRaw !== "token") {
    throw new VaultConfigError("SLAUDE_VAULT_AUTH must be 'kubernetes' or 'token'");
  }
  if (authRaw === "token" && !insecure) {
    throw new VaultConfigError(
      "SLAUDE_VAULT_AUTH=token is for development only (set SLAUDE_VAULT_ALLOW_INSECURE=1)",
    );
  }
  const role = headerSafe(env, "SLAUDE_VAULT_ROLE");
  const token = headerSafe(env, "SLAUDE_VAULT_TOKEN");
  const namespace = headerSafe(env, "SLAUDE_VAULT_NAMESPACE");
  if (authRaw === "kubernetes" && !role) {
    throw new VaultConfigError("SLAUDE_VAULT_ROLE is required for SLAUDE_VAULT_AUTH=kubernetes");
  }
  if (authRaw === "token" && !token) {
    throw new VaultConfigError("SLAUDE_VAULT_TOKEN is required for SLAUDE_VAULT_AUTH=token");
  }

  const rawPrefixes = trimmed(env, "SLAUDE_VAULT_ALLOWED_PREFIXES") ?? "";
  const entries = rawPrefixes
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    // An empty allowlist must not mean "anything" — refuse to start.
    throw new VaultConfigError(
      "SLAUDE_VAULT_ADDR is set but SLAUDE_VAULT_ALLOWED_PREFIXES is empty; refusing to start",
    );
  }

  const rawMounts = trimmed(env, "SLAUDE_VAULT_MOUNTS");
  const mounts = rawMounts
    ? rawMounts
        .split(",")
        .map((s) => s.trim().replace(/\/$/, ""))
        .filter(Boolean)
    : [...new Set(entries.map((e) => e.split("/")[0] ?? ""))];
  for (const m of mounts) {
    const checked = checkVaultPath(m);
    if ("error" in checked) throw new VaultConfigError(`SLAUDE_VAULT_MOUNTS: a mount ${checked.error}`);
  }
  for (const a of mounts) {
    for (const b of mounts) {
      if (a !== b && b.startsWith(`${a}/`)) {
        throw new VaultConfigError(`SLAUDE_VAULT_MOUNTS: '${a}' and '${b}' are nested — ambiguous mount split`);
      }
    }
  }

  return {
    addr: url.origin,
    auth: authRaw,
    role,
    token,
    namespace,
    caCertPath: trimmed(env, "SLAUDE_VAULT_CACERT"),
    jwtPath: trimmed(env, "SLAUDE_VAULT_K8S_TOKEN_PATH") ?? DEFAULT_K8S_JWT_PATH,
    cacheTtlMs: seconds(env, "SLAUDE_VAULT_CACHE_TTL", 60),
    staleMaxMs: seconds(env, "SLAUDE_VAULT_STALE_MAX", 600),
    mounts,
    prefixes: parseAllowedPrefixes(rawPrefixes, mounts),
  };
}

/**
 * Refuse a Vault configuration in a role that cannot protect it (§6.2, §9).
 * `mono`: the agent child shares the process user and can read the pod's
 * service-account token, so there is no boundary. `node`: nodes hold no Vault
 * configuration and make no Vault call; they receive resolved values only, so
 * ANY set SLAUDE_VAULT_* or VAULT_* variable on a node is refused (a stray
 * VAULT_TOKEN would sit in every agent child's reach). The error names the
 * variable, never its value.
 */
export function assertVaultAllowedInRole(role: "mono" | "gateway" | "node", env: Env): void {
  if (role === "node") {
    const names = Object.keys(env)
      .filter((k) => (k.startsWith("SLAUDE_VAULT_") || k.startsWith("VAULT_")) && trimmed(env, k))
      .sort();
    if (names.length > 0) {
      throw new VaultConfigError(
        `${names.join(", ")} must not be set on a node: Vault credentials are resolved by the gateway only.`,
      );
    }
    return;
  }
  if (!trimmed(env, "SLAUDE_VAULT_ADDR")) return;
  if (role === "mono") {
    throw new VaultConfigError(
      "SLAUDE_VAULT_ADDR is not supported with SLAUDE_ROLE=mono: the agent child can read the " +
        "service-account token Vault trusts. Run a gateway and nodes, or use env:// references.",
    );
  }
}
