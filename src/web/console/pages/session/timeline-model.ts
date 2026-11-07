/**
 * The session timeline's model, without React: what the live tail and the
 * conversation record become on the page (pairing, reply tools as messages,
 * earlier turns, turn state). The tabs render these items.
 */
import type { AuditEventView, SessionActivity, SessionDetailResponse, SessionEvent, SessionHistoryItem, SessionUsageSnapshot } from "../../../../gateway/panel/api-types";

/** One frame of the live tail (lib/sessionStream's StreamEntry). */
export interface StreamEntry {
  id: string;
  at: number;
  event: SessionEvent;
}

export interface OperatorMessage {
  id: string;
  at: number;
  text: string;
  by: string;
}

/** Where an agent message went: still sending, posted to the conversation, held in the console, or not sent. */
export type Delivery = "sending" | "posted" | "held" | "failed";

export type Item =
  | { kind: "turn"; key: string; at: number }
  | { kind: "done"; key: string; at: number; ms: number | null }
  | {
      kind: "text"; key: string; at: number; who: "agent" | "operator" | "user"; name: string; text: string;
      /** Set on a message the agent sent through a reply or post tool. */
      delivery?: Delivery;
      /** Where a post tool sent it, when not this thread. */
      target?: string;
      /** From the conversation record (before this page opened). */
      earlier?: boolean;
      /** Only the day is known (an earlier line with no message time of its own). */
      dateOnly?: boolean;
    }
  | { kind: "thinking"; key: string; at: number; text: string }
  | { kind: "tool"; key: string; at: number; tool: string; input: unknown; result?: unknown; resultAt?: number; isError?: boolean }
  | { kind: "result"; key: string; at: number; tool: string; result: unknown; isError: boolean }
  | { kind: "error"; key: string; at: number; message: string; code?: string }
  | { kind: "compacting"; key: string; at: number; trigger: string }
  | { kind: "gate"; key: string; at: number; event: AuditEventView };

export const isErrorResult = (r: unknown) => !!r && typeof r === "object" && (r as { is_error?: unknown }).is_error === true;

/** The text worth showing of a tool result: its output string when it has one, JSON otherwise. */
export function resultText(r: unknown): string {
  if (typeof r === "string") return r;
  if (Array.isArray(r)) {
    // An MCP tool's result: content blocks.
    const parts = r.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).filter(Boolean);
    if (parts.length) return parts.join("\n");
  }
  if (r && typeof r === "object") {
    const o = r as Record<string, unknown>;
    for (const k of ["stdout", "content", "output", "text"]) if (typeof o[k] === "string" && o[k]) return o[k] as string;
    if (Array.isArray(o.content)) {
      const parts = o.content.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).filter(Boolean);
      if (parts.length) return parts.join("\n");
    }
  }
  return JSON.stringify(r, null, 2) ?? "";
}

/**
 * Surface tools whose text the people in the thread (or another channel) read.
 * The agent answers through these, not through assistant text, so the console
 * shows them as the agent's messages rather than as tool rows.
 */
const MESSAGE_TOOLS: Record<string, "thread" | "post" | "proactive"> = {
  mcp__slaude_surface__reply: "thread",
  mcp__slaude_slack__reply: "thread",
  mcp__slaude_slack__post_message: "post",
  mcp__slaude_runtime__proactive_post: "proactive",
};

/** The text of a message tool call, or null for any other call. */
export function messageToolText(tool: string, input: unknown): string | null {
  if (!MESSAGE_TOOLS[tool]) return null;
  const text = (input as { text?: unknown } | null | undefined)?.text;
  return typeof text === "string" && text.trim() ? text : null;
}

/**
 * Where a message tool's text went, from its result: `posted ref=panel-suppressed`
 * means an operator held the session, so Slack never saw it.
 */
export function deliveryOf(result: unknown): Delivery {
  if (isErrorResult(result)) return "failed";
  const text = resultText(result);
  if (/panel-suppressed/.test(text)) return "held";
  if (/"refused"\s*:\s*true|^\s*(refused|error)\b/i.test(text)) return "failed";
  return "posted";
}

type Open = { index: number; id?: string; tool: string };

/**
 * The open call a result belongs to: the call with its tool_use id. An older
 * result has no id (and an empty tool name): the oldest open call of its tool
 * when it names one, else the oldest open call.
 */
function takeOpen(open: Open[], id: string | undefined, tool: string): Open | undefined {
  let i: number;
  if (id) {
    i = open.findIndex((o) => o.id === id);
  } else {
    i = tool ? open.findIndex((o) => o.tool === tool) : -1;
    if (i < 0) i = open.length > 0 ? 0 : -1;
  }
  return i < 0 ? undefined : open.splice(i, 1)[0];
}

export function buildItems(entries: StreamEntry[], gates: AuditEventView[], sent: OperatorMessage[], persona: string): Item[] {
  const out: Item[] = [];
  const open: Open[] = []; // calls awaiting a result, oldest first
  let turnAt: number | null = null;
  for (const { id, at, event: e } of entries) {
    if ("autoEvolve" in e && e.autoEvolve) continue; // the background skill check is not part of the conversation
    switch (e.type) {
      case "turnStart":
        turnAt = at;
        out.push({ kind: "turn", key: id, at });
        break;
      case "done":
        out.push({ kind: "done", key: id, at, ms: turnAt == null ? null : at - turnAt });
        turnAt = null;
        break;
      case "userMessage":
        if (e.text.trim()) out.push({ kind: "text", key: id, at, who: "user", name: e.userName || e.userId, text: e.text });
        break;
      case "assistantText":
        if (e.text.trim()) out.push({ kind: "text", key: id, at, who: "agent", name: persona, text: e.text });
        break;
      case "thinking":
        if (e.text.trim()) out.push({ kind: "thinking", key: id, at, text: e.text });
        break;
      case "toolCall": {
        open.push({ index: out.length, id: e.toolUseId, tool: e.tool });
        const text = messageToolText(e.tool, e.input);
        if (text !== null) {
          const channel = MESSAGE_TOOLS[e.tool] === "post" ? (e.input as { channel?: unknown }).channel : undefined;
          out.push({ kind: "text", key: id, at, who: "agent", name: persona, text, delivery: "sending", ...(typeof channel === "string" ? { target: channel } : {}) });
        } else {
          out.push({ kind: "tool", key: id, at, tool: e.tool, input: e.input });
        }
        break;
      }
      case "toolResult": {
        const o = takeOpen(open, e.toolUseId, e.tool);
        const call = o ? out[o.index] : undefined;
        if (call && call.kind === "tool") {
          out[o!.index] = { ...call, result: e.result, resultAt: at, isError: isErrorResult(e.result) };
        } else if (call && call.kind === "text") {
          out[o!.index] = { ...call, delivery: deliveryOf(e.result) };
        } else {
          out.push({ kind: "result", key: id, at, tool: e.tool, result: e.result, isError: isErrorResult(e.result) });
        }
        break;
      }
      case "error":
        out.push({ kind: "error", key: id, at, message: e.error, code: e.code });
        turnAt = null;
        break;
      case "compacting":
        out.push({ kind: "compacting", key: id, at, trigger: e.trigger });
        break;
      case "tokenUsage":
        break;
    }
  }
  for (const g of gates) out.push({ kind: "gate", key: `gate-${g.id}`, at: g.at, event: g });
  for (const m of sent) out.push({ kind: "text", key: m.id, at: m.at, who: "operator", name: m.by, text: m.text });
  // Stable: stream items keep their order; gates and operator messages slot in by time.
  return out.map((it, i) => [it, i] as const).sort((a, b) => a[0].at - b[0].at || a[1] - b[1]).map(([it]) => it);
}

/** Earlier turns (the conversation record) as timeline messages. */
export function historyItems(history: SessionHistoryItem[], persona: string): Extract<Item, { kind: "text" }>[] {
  return history.map((h) => ({
    kind: "text" as const,
    key: `earlier-${h.id}`,
    at: h.at,
    who: h.who === "agent" ? ("agent" as const) : ("user" as const),
    name: h.who === "agent" ? persona : (h.name ?? "Someone in the thread"),
    text: h.text,
    earlier: true,
    ...(h.dateOnly ? { dateOnly: true } : {}),
  }));
}

/** Slack user id -> name, from the live tail's user messages (who said what). */
export function tailUsers(entries: StreamEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { event: e } of entries) if (e.type === "userMessage" && e.userId && e.userName) out[e.userId] = e.userName;
  return out;
}

/** Whether the newest turn boundary in the tail says a turn is running (undefined: the tail has none). */
export function turnRunning(entries: StreamEntry[]): boolean | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!.event;
    if (e.type === "turnStart") return true;
    if (e.type === "error" || (e.type === "done" && !e.autoEvolve)) return false;
  }
  return undefined;
}

export function latestUsage(entries: StreamEntry[]): SessionUsageSnapshot | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!.event;
    if (e.type === "tokenUsage") return e.snapshot;
  }
  return null;
}

/**
 * What the session is doing now: the live tail's newest turn boundary when it
 * has one (a turn started: working; one ended: no longer working), else what
 * the server said (warm registry or in-process sessions, never the stored status).
 */
export function sessionActivityNow(detail: Pick<SessionDetailResponse, "activity"> | null | undefined, running: boolean | undefined): SessionActivity {
  const server = detail?.activity ?? "idle";
  if (running === true) return "working";
  if (running === false && server === "working") return "warm";
  return server;
}

/** Share of the context window, shown at most 100%, with the token count. */
export function contextLabel(u: Pick<SessionUsageSnapshot, "pctUsed" | "totalInput">): string {
  const pct = Math.max(0, Math.min(100, Math.round(u.pctUsed * 100)));
  return `Context ${pct}% used (${u.totalInput.toLocaleString("en-US")} tokens)`;
}

export type { Item as TimelineItem };
