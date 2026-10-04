/**
 * The variables only a gateway may hold (node labels and routing spec §4.0).
 *
 * One list, three consumers: the node boot check below, the agent child-env
 * scrub (src/agent/child-env.ts), and the manifest policy test that proves the
 * built node Deployment references none of them. Add a name here and all three
 * follow.
 *
 * A node needs only its own credential (SLAUDE_NODE_TOKEN), the Redis URL, the
 * gateway URL and, while the provider env fallback exists, a provider key.
 * Everything below lets its holder act as the gateway: decrypt stored
 * credentials (master key), mint job tokens for any persona and runAs (job
 * secret), mint node credentials (node key), read and write every tenant's
 * rows (database URLs), speak as the Slack app, or rewrite persona identity
 * (deploy tokens, PERSONA_* placeholders, Vault).
 *
 * Some names belong to features that land later (node keys, Vault); they are
 * listed now so later work only consumes the list.
 */
export const GATEWAY_ONLY_ENV_NAMES: readonly string[] = [
  "SLAUDE_MASTER_KEY",
  "SLAUDE_JOB_SECRET",
  "SLAUDE_NODE_KEY",
  "SLAUDE_NODE_KEY_PREVIOUS",
  "SLAUDE_NODE_LEGACY_TOKEN",
  "SLAUDE_PG_URL",
  "SLAUDE_BRAIN_DATABASE_URL",
  "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_USER_TOKEN",
  "SLAUDE_OAUTH_STATE_SECRET",
  "SLAUDE_DEPLOY_TOKEN",
  "SLAUDE_DEPLOY_PREVIEW_TOKEN",
  // The panel and portal sign their sessions with these.
  "SLAUDE_PANEL_SECRET",
  "SLAUDE_PANEL_OIDC_CLIENT_SECRET",
  // The brain's own credentials: a remote brain-server token, the embedding key.
  "SLAUDE_BRAIN_TOKEN",
  "EMBEDDING_API_KEY",
  "LITELLM_API_KEY",
];

/** Every variable starting with one of these is gateway-only. Case-sensitive. */
export const GATEWAY_ONLY_ENV_PREFIXES: readonly string[] = ["SLAUDE_VAULT_", "VAULT_", "PERSONA_"];

const NAMES = new Set(GATEWAY_ONLY_ENV_NAMES);

export function isGatewayOnlyEnv(name: string): boolean {
  return NAMES.has(name) || GATEWAY_ONLY_ENV_PREFIXES.some((p) => name.startsWith(p));
}

/** Gateway-only names set (non-empty) in `env`, sorted. Names only, never values. */
export function gatewayOnlyEnvPresent(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .filter((k) => isGatewayOnlyEnv(k) && (env[k] ?? "") !== "")
    .sort();
}

export type NodeBootCheckMode = "warn" | "refuse";

export interface NodeBootCheckResult {
  /** ok: nothing found. warn: log and boot. refuse: exit non-zero. */
  action: "ok" | "warn" | "refuse";
  /** The configured mode (SLAUDE_NODE_BOOT_CHECK), after defaulting. */
  mode: NodeBootCheckMode;
  /** Offending variable names, sorted. */
  names: string[];
  /** The line to log; names only. Absent when action is ok. */
  message?: string;
}

/**
 * The node's boot check. SLAUDE_NODE_BOOT_CHECK=warn|refuse, default warn: a
 * cluster that has not split its Secrets yet sees the problem before it is
 * stopped. The default becomes refuse in a later release.
 * SLAUDE_NODE_ALLOW_GATEWAY_SECRETS=1 downgrades refuse to warn, a documented,
 * temporary escape.
 */
export function nodeBootCheck(env: Record<string, string | undefined>): NodeBootCheckResult {
  const mode: NodeBootCheckMode = (env.SLAUDE_NODE_BOOT_CHECK ?? "").trim().toLowerCase() === "refuse" ? "refuse" : "warn";
  const names = gatewayOnlyEnvPresent(env);
  if (names.length === 0) return { action: "ok", mode, names };

  const allowed = (env.SLAUDE_NODE_ALLOW_GATEWAY_SECRETS ?? "").trim() === "1";
  const list = names.join(", ");
  if (mode === "refuse" && !allowed) {
    return {
      action: "refuse",
      mode,
      names,
      message:
        `[node] refusing to boot: gateway-only variables are set in this node's environment: ${list}. ` +
        `Load only the node Secret on node pods (see the multi-node deploy guide). ` +
        `SLAUDE_NODE_ALLOW_GATEWAY_SECRETS=1 boots anyway, as a temporary escape.`,
    };
  }
  return {
    action: "warn",
    mode,
    names,
    message:
      `[node] WARNING: gateway-only variables are set in this node's environment: ${list}. ` +
      `A node holding them can act as the gateway; load only the node Secret on node pods ` +
      `(see the multi-node deploy guide)` +
      (mode === "refuse" ? ". Booting because SLAUDE_NODE_ALLOW_GATEWAY_SECRETS=1." : ". A later release refuses to boot."),
  };
}
