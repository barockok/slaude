/**
 * The node's gateway-secrets boot check (node labels and routing spec §4.0).
 * Separate from main.ts, which runs on import, so it can be unit-tested.
 */
import { nodeBootCheck } from "../config/gateway-only-env";
import { securitySwitchViolations } from "../config/security-switches";
import { m as metric } from "../metrics";
import { assertVaultAllowedInRole, VaultConfigError } from "../secrets/config";

/**
 * Runs the check against `env`, logs at most one line (variable names only),
 * and sets slaude_node_gateway_secrets_present to the number of offending
 * variables. Returns false when the node must not boot.
 */
export function enforceNodeBootCheck(
  env: Record<string, string | undefined> = process.env,
  log: (msg: string) => void = (msg) => console.warn(msg),
): boolean {
  // A typo in a boot switch must not silently pick a side: refuse, by name.
  const bad = securitySwitchViolations("node", env);
  for (const line of bad) log(`[node] refusing to boot: ${line}`);
  const r = nodeBootCheck(env);
  if (r.message) log(r.message);
  // Vault settings are new and nothing legitimate sets them on a node (WS-A
  // §6.2, review R1-F3): refuse whatever SLAUDE_NODE_BOOT_CHECK says.
  let vaultRefused = false;
  try {
    assertVaultAllowedInRole("node", env);
  } catch (e) {
    if (!(e instanceof VaultConfigError)) throw e;
    log(`[node] refusing to boot: ${e.message}`);
    vaultRefused = true;
  }
  try {
    metric.nodeGatewaySecretsPresent.set(r.names.length);
  } catch (e) {
    // The gauge is a convenience; it must never decide whether a node boots.
    console.error("[node] could not set slaude_node_gateway_secrets_present:", e instanceof Error ? e.message : e);
  }
  return bad.length === 0 && r.action !== "refuse" && !vaultRefused;
}
