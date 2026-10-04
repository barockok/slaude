/**
 * The node's gateway-secrets boot check (node labels and routing spec §4.0).
 * Separate from main.ts, which runs on import, so it can be unit-tested.
 */
import { nodeBootCheck } from "../config/gateway-only-env";
import { m as metric } from "../metrics";

/**
 * Runs the check against `env`, logs at most one line (variable names only),
 * and sets slaude_node_gateway_secrets_present to the number of offending
 * variables. Returns false when the node must not boot.
 */
export function enforceNodeBootCheck(
  env: Record<string, string | undefined> = process.env,
  log: (msg: string) => void = (msg) => console.warn(msg),
): boolean {
  const r = nodeBootCheck(env);
  metric.nodeGatewaySecretsPresent.set(r.names.length);
  if (r.message) log(r.message);
  return r.action !== "refuse";
}
