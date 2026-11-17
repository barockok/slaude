/**
 * Client-side mirror of the server's grant rules (src/db/agent-grants.ts), so
 * the form can say what is wrong before a round trip. The server stays the
 * authority; its answer is shown as is when it disagrees.
 */
import type { GrantRole, GrantState, SubjectKind } from "../../../gateway/panel/api-types";


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

export const subjectPlaceholder = (k: SubjectKind) => (k === "user" ? `e.g. ${ID_SHAPE[k].example}, email:name@example.com` : `e.g. ${ID_SHAPE[k].example}`);

/**
 * A person written as a typed reference instead of a Slack id: `email:<address>`
 * or `user:<id>` (accepted by the server only while it runs the internal access
 * source), or `slack:user:...`. Such a subject is sent as `subject`.
 */
export const isPersonRef = (v: string): boolean => /^(email|user|slack:user):/i.test(v.trim());

/** Ids are upper case; a typed reference keeps the case it was written in (an address is not an id). */
export const normaliseSubjectInput = (v: string): string => (isPersonRef(v) ? v : v.toUpperCase());

/** What a grant that names a person by email or user reference does now, as a short label and a tone. */
export const STATE_LABEL: Record<GrantState, string> = {
  active: "Active",
  "pending: no verified email binding": "Pending: no verified email",
  "pending: Slack binding not verified": "Pending: Slack not verified",
  "inactive: access source is not internal": "Inactive: source is not internal",
};
export const STATE_TONE: Record<GrantState, "success" | "warning" | "neutral"> = {
  active: "success",
  "pending: no verified email binding": "warning",
  "pending: Slack binding not verified": "warning",
  "inactive: access source is not internal": "neutral",
};
export const STATE_HINT: Record<GrantState, string> = {
  active: "This grant reaches the person now.",
  "pending: no verified email binding": "Nobody has logged in with this email as a proven address yet, so this grant does nothing until they do.",
  "pending: Slack binding not verified": "The person is known but their Slack account is not linked through the portal link, so the manager or approver part does not apply yet.",
  "inactive: access source is not internal": "The gateway is not running with SLAUDE_ACCESS_SOURCE=internal, so nothing reads this grant.",
};

/** Roles a subject kind may hold: channels and workspaces are members only. */
export const rolesFor = (k: SubjectKind): GrantRole[] => (k === "user" ? GRANT_ROLES : ["member"]);

/** Null when the id is valid for the kind, else what is wrong. */
export function subjectIdError(kind: SubjectKind, id: string): string | null {
  const v = id.trim();
  if (!v) return "Enter a Slack id.";
  if (kind === "user" && isPersonRef(v)) {
    if (v.length > 300) return "That reference is too long.";
    if (/^email:/i.test(v) && !/^email:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(v)) return "An email reference is email: followed by one plain address.";
    if (/^user:/i.test(v) && !/^user:\S+$/i.test(v)) return "A user reference is user: followed by the record id.";
    return null;
  }
  if (v.length > 64) return "That id is too long.";
  if (kind === "channel" && /^D[A-Z0-9]+$/.test(v)) return DM_MESSAGE;
  if (!ID_SHAPE[kind].re.test(v)) return ID_SHAPE[kind].message;
  return null;
}
