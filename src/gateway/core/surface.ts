// The platform-neutral interaction contract the agent talks to. A Surface is bound to one
// conversation for one session. Real adapters (Slack, …) implement it; the sim drives the
// *real* implementation over a fake transport, so the agent cannot tell sim from prod.
// See docs/superpowers/specs/2026-06-03-surface-abstraction-design.md.

export type SurfaceCapability = "edit" | "react" | "upload" | "typing" | "ephemeral";

/** One message in conversation history. Core fields are universal; the optional fields
 *  preserve Slack's get_thread_history output verbatim and are omitted by thinner surfaces. */
export interface HistoryItem {
  author: string;
  text: string;
  ref: string;            // slack: ts
  threadRef?: string;     // slack: thread_ts
  replyCount?: number;    // slack: reply_count
  replies?: unknown[];    // slack: nested replies when includeReplies
}

export interface ApprovalRequest {
  summary: string;
  tools?: string[];
  files?: string[];
  risks?: string;
  category?: string;
}

export interface ApprovalResult {
  approved: boolean;
  by: string;
  note?: string;
}

export interface Surface {
  readonly id: string;                          // real platform id, e.g. "slack"
  readonly capabilities: ReadonlySet<SurfaceCapability>;

  // core — every surface MUST implement:
  /** `runtime`: the runtime's own text (a todo list, a connect notice), formatted
   *  but never held or refused by the owner's reply rules. A reply an owner rule
   *  refuses throws OutboundRefusal; `note` says it was held and approved. */
  reply(i: { text: string; runtime?: boolean }): Promise<{ ref: string; note?: string }>;
  getHistory(i: { limit?: number; includeReplies?: boolean }): Promise<{ messages: HistoryItem[]; hasMore: boolean }>;
  requestApproval(r: ApprovalRequest): Promise<ApprovalResult>;

  // optional — present iff the matching capability is declared:
  edit?(i: { ref: string; text: string; runtime?: boolean }): Promise<void | { note?: string }>; // cap: "edit"
  react?(i: { name: string; ref?: string }): Promise<void>;      // cap: "react"
  unreact?(i: { name: string; ref?: string }): Promise<void>;    // cap: "react" (rides with react)
  upload?(i: { path: string; title?: string; comment?: string; altText?: string }): Promise<void>; // cap: "upload"
  typing?(i: { on: boolean }): Promise<void>;                    // cap: "typing"
  /** Post a message only `userId` can see (default: the binding's user).
   *  cap: "ephemeral". MUST throw rather than fall back to a public post —
   *  callers reach for it precisely because the content is not for the channel. */
  sayEphemeral?(i: { text: string; userId?: string; blocks?: unknown[] }): Promise<void>; // cap: "ephemeral"
}

/** Neutral per-session binding the gateway builds from the inbound turn. A SurfaceFactory
 *  closes over the transport client and turns a binding into a Surface. */
export interface SessionBinding {
  conversationId: string;     // slack: channel
  threadRef?: string;         // slack: threadTs
  inboundRef: string;         // slack: inboundTs
  userId?: string;
  teamId?: string;
  requestApproval: (r: ApprovalRequest) => Promise<ApprovalResult>;
  reloadSession: (prompt?: string) => boolean;
  /** The session posting (owner reply rules: audit rows, the held reply's card). */
  sessionId?: string;
  /** Nobody is in this turn (a wake): an owner approve rule is a deny. */
  unattended?: boolean;
  /** The Slack app the session posts as (a held reply's card goes out as it). */
  appId?: string;
}

export type SurfaceFactory = (b: SessionBinding) => Surface;

/** The id of the Slack surface (SlackSurface.id). */
export const SLACK_SURFACE_ID = "slack";

/**
 * The surface a session's conversation is on. Every session is created for a
 * Slack thread today (Sessions.createForThread keys rows by team, channel and
 * thread), so this is the one place that says so: the panel's session views,
 * history lines, live-tail user messages and audit context all read it here.
 * When a second surface lands, sessions carry their own and this reads it.
 */
export function surfaceOfSession(_row?: { slack_channel_id?: string | null } | null): typeof SLACK_SURFACE_ID {
  return SLACK_SURFACE_ID;
}
