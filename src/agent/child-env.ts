/**
 * Strip secrets that must never reach the SDK child or any subprocess it spawns.
 * Kept in its own module so it can be unit-tested without loading the whole
 * AgentManager (which would otherwise drag untested manager code into coverage).
 *
 * The child runs the agent's tools, Bash included, so anything it inherits a
 * prompt-injected turn can read. In mono the child shares a process
 * environment with the gateway, so it must hold no credential that writes
 * persona state or speaks for the gateway. That is every gateway-only variable
 * (src/config/gateway-only-env.ts: the master key, the job secret, node keys,
 * the database URLs, the Slack secrets, deploy tokens, PERSONA_* placeholders
 * and Vault settings), plus:
 *   - SLAUDE_NODE_TOKEN, the node's own /v1 credential;
 *   - SLAUDE_ENCRYPTION_KEY, the connect broker's key.
 * Every consumer of these reads them in the slaude process itself (MCP
 * placeholders are expanded before the config reaches the child), so the
 * child needs none of them.
 */
import { isGatewayOnlyEnv } from "../config/gateway-only-env";

const ALSO_STRIPPED = new Set(["SLAUDE_ENCRYPTION_KEY", "SLAUDE_NODE_TOKEN"]);

export function scrubChildEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    if (ALSO_STRIPPED.has(k) || isGatewayOnlyEnv(k)) continue;
    out[k] = v;
  }
  return out;
}
