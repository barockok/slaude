// The platform-neutral interaction contract the agent talks to. A Surface is bound to one
// conversation for one session. Real adapters (Slack, …) implement it; the sim drives the
// *real* implementation over a fake transport, so the agent cannot tell sim from prod.
// See docs/superpowers/specs/2026-06-03-surface-abstraction-design.md.

export type SurfaceCapability = "edit" | "react" | "upload" | "typing";

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
  reply(i: { text: string }): Promise<{ ref: string }>;
  getHistory(i: { limit?: number; includeReplies?: boolean }): Promise<{ messages: HistoryItem[]; hasMore: boolean }>;
  requestApproval(r: ApprovalRequest): Promise<ApprovalResult>;

  // optional — present iff the matching capability is declared:
  edit?(i: { ref: string; text: string }): Promise<void>;        // cap: "edit"
  react?(i: { name: string; ref?: string }): Promise<void>;      // cap: "react"
  unreact?(i: { name: string; ref?: string }): Promise<void>;    // cap: "react" (rides with react)
  upload?(i: { path: string; title?: string; comment?: string; altText?: string }): Promise<void>; // cap: "upload"
  typing?(i: { on: boolean }): Promise<void>;                    // cap: "typing"
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
  reloadSession: () => boolean;
}

export type SurfaceFactory = (b: SessionBinding) => Surface;
