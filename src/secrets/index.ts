/**
 * src/secrets — persona provider credentials by reference (WS-A §4–§6).
 *
 *   ref.ts          parseRef / canonicalRef: the reference grammar (syntax only)
 *   config.ts       loadVaultConfig (SLAUDE_VAULT_*), assertVaultAllowedInRole
 *   allowlist.ts    mount split and the allowed-prefix rule on the final request path
 *   vault.ts        the Vault HTTP client (Kubernetes/token auth, KV v2)
 *   cache.ts        per-reference cache, single flight, bounded stale serving
 *   env-backend.ts  env://PERSONA_*
 *   errors.ts       SecretResolutionError and its reason enum
 *
 * Resolution runs on the gateway only (at runtime-bundle build); nodes and the
 * agent child never see Vault. Every resolve re-validates the reference and
 * re-checks the allowlist before any network call, so a stored row written
 * some other way cannot bypass the sync-time check. Each resolve emits one
 * `provider.cred.resolve` event with persona, scheme, outcome and duration —
 * never the path, field or value.
 */
import { requestPathFor, isAllowed, splitMount } from "./allowlist";
import { createSecretCache, type CacheOutcome } from "./cache";
import type { VaultConfig } from "./config";
import { createEnvBackend } from "./env-backend";
import { SecretResolutionError, type SecretFailureReason } from "./errors";
import { canonicalRef, parseRef, type SecretRef } from "./ref";
import { createVaultClient, type VaultClientDeps } from "./vault";

export { parseRef, canonicalRef, SecretRefError, type SecretRef } from "./ref";
export { SecretResolutionError, type SecretFailureReason } from "./errors";
export { loadVaultConfig, assertVaultAllowedInRole, VaultConfigError, type VaultConfig } from "./config";

export interface SecretResolver {
  resolve(ref: SecretRef, ctx: { persona: string }): Promise<string>;
}

export type ResolveOutcome = "ok" | "cached" | "stale" | "denied" | "error";

export type ResolveEvent = {
  event: "provider.cred.resolve";
  persona: string;
  scheme: SecretRef["scheme"];
  outcome: ResolveOutcome;
  durationMs: number;
  reason?: SecretFailureReason;
};

const DENIED: ReadonlySet<SecretFailureReason> = new Set(["prefix", "denied"]);

function defaultOnEvent(e: ResolveEvent): void {
  const line = JSON.stringify(e);
  if (e.outcome === "denied" || e.outcome === "error") console.error(line);
  else console.log(line);
}

export function createSecretResolver(opts: {
  env: Record<string, string | undefined>;
  /** from loadVaultConfig; null/undefined = no Vault backend */
  vault?: VaultConfig | null;
  fetch?: typeof fetch;
  /** a monotonic clock in ms; default performance.now() */
  now?: () => number;
  readFile?: VaultClientDeps["readFile"];
  vaultDeps?: Omit<VaultClientDeps, "fetch" | "now" | "readFile">;
  onEvent?: (e: ResolveEvent) => void;
  /** called each time a stale value is served (wire to a counter) */
  onStale?: () => void;
}): SecretResolver {
  // Monotonic: every interval here (TTL, stale age, login rate limit, duration)
  // must not move when the wall clock is stepped.
  const now = opts.now ?? (() => performance.now());
  const onEvent = opts.onEvent ?? defaultOnEvent;
  const envBackend = createEnvBackend(opts.env);
  const vaultCfg = opts.vault ?? null;
  const client = vaultCfg
    ? createVaultClient(vaultCfg, { ...opts.vaultDeps, fetch: opts.fetch, now, readFile: opts.readFile })
    : null;
  const cache = vaultCfg
    ? createSecretCache({ ttlMs: vaultCfg.cacheTtlMs, staleMaxMs: vaultCfg.staleMaxMs, now, onStale: opts.onStale })
    : null;

  async function resolveVault(ref: SecretRef & { scheme: "vault" }, persona: string) {
    if (!vaultCfg || !client || !cache) {
      throw new SecretResolutionError("disabled", "vault:// reference but Vault is not configured on this gateway");
    }
    const finalPath = requestPathFor(ref, vaultCfg.mounts);
    if (!isAllowed(finalPath, persona, vaultCfg.prefixes)) {
      throw new SecretResolutionError("prefix", "secret reference is outside SLAUDE_VAULT_ALLOWED_PREFIXES");
    }
    const { mount, path } = splitMount(ref.path, vaultCfg.mounts);
    return cache.get(canonicalRef(ref), () => client.read(mount, path, ref.field));
  }

  return {
    async resolve(ref0, ctx) {
      const started = now();
      const scheme = ref0.scheme;
      const emit = (outcome: ResolveOutcome, reason?: SecretFailureReason) =>
        onEvent({
          event: "provider.cred.resolve",
          persona: ctx.persona,
          scheme,
          outcome,
          durationMs: Math.max(0, now() - started),
          ...(reason ? { reason } : {}),
        });
      try {
        // Re-validate: a SecretRef may have been built or stored without parseRef.
        let ref: SecretRef;
        try {
          ref = parseRef(canonicalRef(ref0));
        } catch {
          throw new SecretResolutionError("invalid_ref", "secret reference does not parse");
        }
        let value: string;
        let outcome: CacheOutcome;
        if (ref.scheme === "env") {
          value = envBackend.read(ref.name);
          outcome = "ok";
        } else {
          ({ value, outcome } = await resolveVault(ref, ctx.persona));
        }
        emit(outcome);
        return value;
      } catch (err) {
        const reason = err instanceof SecretResolutionError ? err.reason : undefined;
        emit(reason && DENIED.has(reason) ? "denied" : "error", reason);
        throw err;
      }
    },
  };
}
