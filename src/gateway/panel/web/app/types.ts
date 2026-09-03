// Wire types mirrored from the panel API (src/gateway/panel/enumerator.ts and
// src/agent/manager.ts AgentEvent). Kept standalone so the web bundle has no
// backend import graph.

/** Who the panel session belongs to, as reported by GET /panel/auth/me. */
export interface Me {
  email: string;
  role: "superadmin" | "operator";
}

export interface SessionSummary {
  id: string;
  persona_id: string;
  model: string;
  status: string;
  claude_started: number;
  engaged: number;
  title: string | null;
  working_dir: string;
  slack_team_id: string | null;
  slack_channel_id: string | null;
  slack_thread_ts: string | null;
  created_at: number;
  updated_at: number;
  tenant_id?: string;
  warm: boolean;
  node?: string;
  panel_locked_by?: string;
  /** UI-only enrichment: last-known context usage (0..1). Absent for real rows
   *  until a tokenUsage event has been seen; fixtures seed it for the gauntlet. */
  ctx_pct?: number;
}

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalInput: number;
  contextWindow: number;
  pctUsed: number;
  remaining: number;
}

export type AgentEvent =
  | { type: "assistantText"; sessionId: string; text: string }
  | { type: "toolCall"; sessionId: string; tool: string; input: unknown }
  | { type: "toolResult"; sessionId: string; tool: string; result: unknown }
  | { type: "thinking"; sessionId: string; text: string }
  | { type: "turnStart"; sessionId: string }
  | { type: "done"; sessionId: string; autoEvolve?: boolean }
  | { type: "error"; sessionId: string; error: string }
  | { type: "tokenUsage"; sessionId: string; snapshot: UsageSnapshot }
  | { type: "compacting"; sessionId: string; trigger: "manual" | "auto" };

/** SSE frame as the timeline stores it: server entry id + parsed event. */
export interface TimelineEntry {
  id: string;
  ts: number;
  event: AgentEvent;
}
