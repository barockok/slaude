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
 *   - SLAUDE_REDIS_URL, every session's queue, locks and event stream (the
 *     node process uses it; the child never does);
 *   - SLAUDE_ENCRYPTION_KEY, the connect broker's key.
 * Every consumer of these reads them in the slaude process itself (MCP
 * placeholders are expanded before the config reaches the child), so the
 * child needs none of them.
 */
import { isGatewayOnlyEnv } from "../config/gateway-only-env";

const ALSO_STRIPPED = new Set(["SLAUDE_ENCRYPTION_KEY", "SLAUDE_NODE_TOKEN", "SLAUDE_REDIS_URL"]);

/** True for every name scrubChildEnv strips: no subprocess may hold it. */
export function isChildScrubbedEnv(name: string): boolean {
  return ALSO_STRIPPED.has(name) || isGatewayOnlyEnv(name);
}

export function scrubChildEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    if (isChildScrubbedEnv(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * A child-env overlay that also REMOVES variables (WS-A §5.4). `set` is laid
 * over the process-env-derived provider vars; every name in `unset` that `set`
 * does not supply is deleted from the child's environment object — deleted, not
 * set to undefined, since how a spawn treats an undefined value is unverified
 * and a missing key cannot be misread. A plain record overlay only adds.
 */
export class ChildEnvPatch {
  constructor(
    readonly set: Record<string, string>,
    readonly unset: readonly string[],
  ) {}
}

/** `env` without the names in `unset` (a new object; the input is untouched). */
export function withoutKeys(env: Record<string, string | undefined>, unset: readonly string[]): Record<string, string | undefined> {
  const out = { ...env };
  for (const k of unset) delete out[k];
  return out;
}

/**
 * Defence in depth for model children that read untrusted content. Measured
 * against SDK 0.3.173 with a stub model: under `tools: []` alone the CLI still
 * offered these three; with them also in `disallowedTools` it offered none.
 * Neither layer is the one that stops execution: the non-bypass permission
 * mode denies them (a Monitor call was refused under dontAsk). Keeping the
 * list means a newer CLI that leaks the same tools still offers nothing.
 */
export const TOOLS_SURVIVING_EMPTY_SET = ["Monitor", "PushNotification", "DesignSync"] as const;
