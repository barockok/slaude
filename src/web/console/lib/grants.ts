/**
 * Client-side mirror of the server's grant rules (src/db/agent-grants.ts), so
 * the form can say what is wrong before a round trip. The server stays the
 * authority; its answer is shown as is when it disagrees.
 */
import type { GrantRole, SubjectKind } from "../../../gateway/panel/api-types";

export { ROLE_LABEL, ROLE_TONE } from "../../shared/RoleBadge";

export const SUBJECT_KINDS: SubjectKind[] = ["user", "channel", "workspace"];
export const GRANT_ROLES: GrantRole[] = ["manager", "approver", "member"];

export const SUBJECT_LABEL: Record<SubjectKind, string> = { user: "User", channel: "Channel", workspace: "Workspace" };

const ID_SHAPE: Record<SubjectKind, { re: RegExp; example: string; message: string }> = {
  user: { re: /^[UW][A-Z0-9]+$/, example: "U1234ABCD", message: "A Slack user id starts with U or W, then uppercase letters and digits." },
  channel: { re: /^[CG][A-Z0-9]+$/, example: "C1234ABCD", message: "A Slack channel id starts with C or G, then uppercase letters and digits." },
  workspace: { re: /^T[A-Z0-9]+$/, example: "T1234ABCD", message: "A Slack workspace id starts with T, then uppercase letters and digits." },
};

/** A DM id given as a channel: DMs are covered by a user member grant with DM only. */
export const DM_MESSAGE = "That is a DM, not a channel. To let someone DM the agent, give them a user member grant with DM only.";

export const subjectPlaceholder = (k: SubjectKind) => `e.g. ${ID_SHAPE[k].example}`;

/** Roles a subject kind may hold: channels and workspaces are members only. */
export const rolesFor = (k: SubjectKind): GrantRole[] => (k === "user" ? GRANT_ROLES : ["member"]);

/** Null when the id is valid for the kind, else what is wrong. */
export function subjectIdError(kind: SubjectKind, id: string): string | null {
  const v = id.trim();
  if (!v) return "Enter a Slack id.";
  if (v.length > 64) return "That id is too long.";
  if (kind === "channel" && /^D[A-Z0-9]+$/.test(v)) return DM_MESSAGE;
  if (!ID_SHAPE[kind].re.test(v)) return ID_SHAPE[kind].message;
  return null;
}
