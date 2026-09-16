/**
 * One place that answers "which config home does this MCP credential belong to".
 *
 * Connect and disconnect must agree, and they did not: connect nested the
 * initiator's home under a named persona while disconnect resolved the flat
 * home, so disconnecting a named persona's server searched an empty directory,
 * reported that nothing was connected, and left a working token behind at
 * oauth/<persona>/<userId>. The person believed access was revoked and it was
 * not. Routing every caller through one function removes the ability to
 * disagree.
 */
import { agentConfigDir, ensureInitiatorConfigDir } from "../oauth-home";

/** Whose identity a credential belongs to: the agent's shared identity, or the
 *  user who initiated the connect. */
export type ConnectScope = "initiator" | "global";

/**
 * Normalize a dispatch persona id to the persona key the oauth home uses.
 * The implicit `default` persona owns no directory of its own, so it and an
 * absent persona both resolve to undefined.
 */
export function personaKey(personaId?: string | null): string | undefined {
  return personaId && personaId !== "default" ? personaId : undefined;
}

/**
 * Config home a credential scope acts on. Global scope writes the agent's own
 * config dir, which is the live CLAUDE_CONFIG_DIR and always present. Initiator
 * scope writes that user's home, nested under the persona when one is named;
 * the directory is created if absent, because the connect flow can run before
 * any locked session has booted.
 */
export function scopeConfigDir(
  scope: ConnectScope,
  userId: string,
  personaId?: string | null,
): string {
  return scope === "global"
    ? agentConfigDir()
    : ensureInitiatorConfigDir(userId, personaKey(personaId));
}
