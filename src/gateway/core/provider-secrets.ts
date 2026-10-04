/**
 * The gateway's provider-credential resolver (WS-A §5, §7), built once at boot
 * from its own environment and used by the runtime-bundle builder.
 *
 * Events go to the project's log and metrics instead of the secrets module's
 * default stdout sink: one `provider.cred.resolve` line with persona, scheme,
 * outcome, duration and (on failure) the internal reason — never the path,
 * field or value — plus `provider_cred_resolve_total{scheme,outcome}` and
 * `provider_cred_stale_served_total`. A refused (`denied`) or failed resolution
 * logs at error level, as §7 requires for an allowlist refusal.
 */
import { m as metric } from "../../metrics";
import { createSecretResolver, loadVaultConfig, type ResolveEvent, type SecretResolver } from "../../secrets";

export function logResolveEvent(e: ResolveEvent): void {
  metric.providerCredResolveTotal.inc({ scheme: e.scheme, outcome: e.outcome });
  const line =
    `[provider.cred.resolve] persona=${e.persona} scheme=${e.scheme} outcome=${e.outcome} ` +
    `duration_ms=${Math.round(e.durationMs)}${e.reason ? ` reason=${e.reason}` : ""}`;
  if (e.outcome === "denied" || e.outcome === "error") console.error(line);
  else console.log(line);
}

/**
 * Build the resolver from `env`. Throws VaultConfigError on any Vault
 * misconfiguration, including SLAUDE_VAULT_ADDR with an empty allowlist: the
 * caller (boot) lets it stop the process.
 */
export function buildProviderSecretResolver(
  env: Record<string, string | undefined>,
  deps: Pick<Parameters<typeof createSecretResolver>[0], "fetch" | "now" | "readFile"> = {},
): SecretResolver {
  return createSecretResolver({
    env,
    vault: loadVaultConfig(env),
    ...deps,
    onEvent: logResolveEvent,
    onStale: () => metric.providerCredStaleServedTotal.inc(),
  });
}
