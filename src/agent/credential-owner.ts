/**
 * Whose MCP credentials a turn uses.
 *
 * Decided once, at dispatch, by the same rule the node uses to pick its config
 * directory (AgentManager.resolveEffectiveIdentity), and signed into the job
 * token as `runAs`. Nothing downstream re-derives it, so the directory a node
 * seeds and the credentials the gateway serves cannot disagree.
 *
 * The agent is keyed on (tenant, persona), matching how the runtime bundle
 * resolves an agent's identity. A person is keyed on their account, so one
 * person in two Slack workspaces has one set of integrations.
 */
export type CredentialOwner =
  | { kind: "agent"; tenant: string; persona: string }
  | { kind: "account"; accountId: string };

/** The identity a turn runs as, as carried in the job token's `runAs` claim. */
export type RunAs = { kind: "agent" } | { kind: "user"; slackUserId: string };

/** Slack user ids are short alphanumerics. Anything else — notably a ':' that
 *  could smuggle a second field — is not an id this codebase minted. */
const SLACK_USER_ID = /^[A-Za-z0-9_-]+$/;

/** `runAs` claim value for a turn: the lock owner's Slack id, or the agent. */
export function encodeRunAs(slackUserId: string | undefined): string {
  if (slackUserId === undefined) return "agent";
  if (!SLACK_USER_ID.test(slackUserId)) {
    throw new Error("refusing to encode a runAs for a malformed Slack user id");
  }
  return `user:${slackUserId}`;
}

/** Parse a `runAs` claim. Null for anything encodeRunAs could not have produced:
 *  callers must refuse on null, never fall back to the agent. */
export function parseRunAs(raw: unknown): RunAs | null {
  if (raw === "agent") return { kind: "agent" };
  if (typeof raw !== "string" || !raw.startsWith("user:")) return null;
  const id = raw.slice("user:".length);
  return SLACK_USER_ID.test(id) ? { kind: "user", slackUserId: id } : null;
}
