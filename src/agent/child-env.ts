/**
 * Strip secrets that must never reach the SDK child or any subprocess it spawns.
 * Kept in its own module so it can be unit-tested without loading the whole
 * AgentManager (which would otherwise drag untested manager code into coverage).
 *
 * The child runs the agent's tools, Bash included, so anything it inherits a
 * prompt-injected turn can read. In mono the child shares a process
 * environment with the gateway, so it must hold no credential that writes
 * persona state or speaks for the gateway:
 *   - SLAUDE_DEPLOY_TOKEN / SLAUDE_DEPLOY_PREVIEW_TOKEN authenticate /deploy;
 *   - PERSONA_* are the placeholders a persona sync resolves (Slack user
 *     tokens, MCP credentials) — every persona's, not just the session's;
 *   - SLAUDE_MASTER_KEY decrypts stored credentials and keys the soul cache MAC;
 *   - SLAUDE_NODE_TOKEN / SLAUDE_JOB_SECRET authenticate and mint /v1 calls.
 * Every consumer of these reads them in the slaude process itself (MCP
 * placeholders are expanded before the config reaches the child), so the
 * child needs none of them.
 */
const STRIPPED = new Set([
  "SLAUDE_ENCRYPTION_KEY",
  "SLAUDE_DEPLOY_TOKEN",
  "SLAUDE_DEPLOY_PREVIEW_TOKEN",
  "SLAUDE_MASTER_KEY",
  "SLAUDE_NODE_TOKEN",
  "SLAUDE_JOB_SECRET",
]);

export function scrubChildEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    if (STRIPPED.has(k) || k.startsWith("PERSONA_")) continue;
    out[k] = v;
  }
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
