/**
 * The gateway's provider-credential resolver (WS-A §5, §7), built once at boot
 * from its own environment and used by the runtime-bundle builder.
 *
 * Events go to the project's log and metrics instead of the secrets module's
 * default stdout sink: one `provider.cred.resolve` line with persona, scheme,
 * outcome, duration and (on failure) the internal reason — never the path,
 * field or value — plus `slaude_provider_cred_resolve_total{scheme,outcome}` and
 * `slaude_provider_cred_stale_served_total`. A refused (`denied`) or failed resolution
 * logs at error level, as §7 requires for an allowlist refusal.
 */
import { m as metric } from "../../metrics";
import {
  assertVaultAllowedInRole, createSecretResolver, loadVaultConfig, type ResolveEvent, type SecretResolver,
} from "../../secrets";

export function logResolveEvent(e: ResolveEvent): void {
  metric.providerCredResolveTotal.inc({ scheme: e.scheme, outcome: e.outcome });
  const line =
    `[provider.cred.resolve] persona=${e.persona} scheme=${e.scheme} outcome=${e.outcome} ` +
    `duration_ms=${Math.round(e.durationMs)}${e.reason ? ` reason=${e.reason}` : ""}`;
  if (e.outcome === "denied" || e.outcome === "error") console.error(line);
  else console.log(line);
}

/**
 * `mono` installs no child-env resolver (only a node worker does), so a
 * persona's provider references would be silently ignored there and the
 * persona would run on the process's own credentials. Refuse instead (WS-A
 * §5.2), naming the personas. Called at boot and by sync.
 */
export function assertNoProviderRefsInMono(role: "mono" | "gateway" | "node", personas: readonly string[]): void {
  if (role !== "mono" || personas.length === 0) return;
  throw new Error(
    `persona provider references are not supported with SLAUDE_ROLE=mono (set by: ${personas.join(", ")}). ` +
      "Run a gateway and nodes, or remove `provider` from these personas.",
  );
}

/**
 * Boot step (src/server.ts), before anything is opened: refuse Vault settings
 * in a role that cannot protect them (any SLAUDE_VAULT_* / VAULT_* on a node;
 * SLAUDE_VAULT_ADDR in mono), then build the gateway/mono resolver from the
 * environment — which refuses Vault with an empty allowlist. A node resolves
 * nothing: null.
 */
export function bootProviderSecretResolver(
  role: "mono" | "gateway" | "node",
  env: Record<string, string | undefined>,
): SecretResolver | null {
  assertVaultAllowedInRole(role, env);
  return role === "node" ? null : buildProviderSecretResolver(env);
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
