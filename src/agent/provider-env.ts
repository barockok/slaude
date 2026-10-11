/**
 * The environment variables that select or authenticate a model provider.
 * Used by the node's strict provider rule (src/node/worker.ts, nodeChildEnv)
 * and by mono's /bash, whose output is posted to Slack (src/gateway/core/gateway.ts).
 */

/** The provider variables a bundle can supply (WS-A §4). */
export const PROVIDER_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
] as const;

/**
 * Node variables that select or authenticate a model provider, as FAMILIES
 * (review R2-F3, re-check F2): the bundled CLI keeps adding provider modes
 * (Bedrock, Vertex, Foundry, Mantle, a gateway mode) with their own switches,
 * keys, identity tokens and client certificates, so a fixed list goes stale.
 * Under the strict rule below a node's value for any of them must not reach a
 * managed persona's child, or the persona would be steered to (or billed on)
 * the node's provider. Every `ANTHROPIC_*` the bundle did not supply goes.
 */
export const PROVIDER_SELECTING_ENV_PREFIXES: readonly string[] = [
  "ANTHROPIC_",
  "CLAUDE_CODE_USE_",
  "CLAUDE_CODE_OAUTH_",
  "CLAUDE_CODE_API_KEY_",
  "CLAUDE_CODE_CLIENT_",
  "AWS_",
];
/** Exact names outside the families (and the four a bundle supplies, listed
 *  so they are removed even when the node does not hold them). */
export const PROVIDER_SELECTING_ENV_NAMES: readonly string[] = [...PROVIDER_ENV_KEYS, "GOOGLE_APPLICATION_CREDENTIALS"];

/**
 * Never removed by the strict rule, whatever a family says: what the CLI and
 * slaude need for the child to run at all. None of these matches a family
 * today; the list makes that a tested promise rather than an accident.
 */
export const CHILD_ENV_KEEP: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TMPDIR",
  "LANG",
  "CLAUDE_CONFIG_DIR",
  "ENABLE_TOOL_SEARCH",
  "SLAUDE_AGENT_ID",
  "DISABLE_TELEMETRY",
  "DISABLE_AUTOUPDATER",
  "DISABLE_BUG_COMMAND",
  "DISABLE_ERROR_REPORTING",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
];

/** The provider-selecting names to delete, given the node's environment. */
export function providerSelectingNames(nodeEnv: Record<string, string | undefined>): string[] {
  const keep = new Set(CHILD_ENV_KEEP);
  const names = new Set<string>(PROVIDER_SELECTING_ENV_NAMES);
  for (const k of Object.keys(nodeEnv)) {
    if (PROVIDER_SELECTING_ENV_PREFIXES.some((p) => k.startsWith(p))) names.add(k);
  }
  return [...names].filter((k) => !keep.has(k));
}
