/**
 * A session's earlier turns for the console, from its durable conversation
 * record: the `conversations/<session>` page the brain memory provider appends
 * one timeline row per turn to (src/memory/brain-provider.ts), read from the
 * agent's own source only (the persona's `agent-<id>` slice, and the legacy
 * `agent` source for the default persona). A turn recorded into a person's
 * slice (their /1on1 or DM) is not read here.
 *
 * Read through the memory browser (gbrain's engine surface), never SQL. Every
 * line is redacted before it leaves.
 */
import type { SessionRow } from "../../db/schema";
import type { MemoryBrowser, MemoryTimelineRow } from "../../knowledge/memory-browse";
import { agentIdSync } from "../../knowledge/agent-identity";
import { AGENT_SOURCE, agentSourceId } from "../../knowledge/scope";
import { conversationSlug } from "../../memory/brain-provider";
import { PersonaNotLiveError } from "../../persona/registry";
import { personaAgentId } from "../../persona/agent-slice";
import { redactSecrets } from "../../redact";
import type { MemoryEntryLine, MemoryEntryView, SessionHistoryItem, SessionHistoryResponse } from "./api-types";
import { surfaceOfSession } from "../core/surface";

/** Rows read per request: the page is cut from these. */
export const MAX_ROWS = 1000;

/**
 * The agent sources a session's conversation page may live in, own slice
 * first: the slice the writer resolves (personaAgentId), and the legacy
 * `agent` source when that is the process agent. A managed persona that is
 * not live has none.
 */
export function agentSourcesFor(personaId: string | null | undefined): string[] {
  let id: string;
  try {
    id = personaAgentId(personaId);
  } catch (e) {
    if (e instanceof PersonaNotLiveError) return [];
    throw e;
  }
  return id === agentIdSync() ? [agentSourceId(id), AGENT_SOURCE] : [agentSourceId(id)];
}

const attr = (open: string, name: string): string | undefined => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(open);
  return m ? m[1] : undefined;
};

const unescapeAttr = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/**
 * The user line of a recorded turn. The record keeps the turn's input as the
 * model got it: a `<channel ...>` envelope around the message, then runtime
 * instructions. Only the message (and the sender's display name) is shown.
 */
export function parseUserLine(raw: string): { text: string; name?: string; at?: number } {
  const s = raw.trim();
  const m = /^<(channel|cron|wake|heartbeat)\b([^>]*)>\n?([\s\S]*?)(?:\n?<\/\1>[\s\S]*)?$/.exec(s);
  if (!m) return { text: s };
  const open = m[2] ?? "";
  const text = (m[3] ?? "").trim();
  const userName = attr(open, "user_name");
  const name = userName ? unescapeAttr(userName) : undefined;
  const at = slackTsMs(attr(open, "inbound_ts"));
  return { text, ...(name ? { name: attr(open, "source") === "panel" ? `${name} (console)` : name } : {}), ...(at !== null ? { at } : {}) };
}

/** A Slack message ts (`1762506060.000100`) as epoch ms, or null. */
export function slackTsMs(ts: string | undefined): number | null {
  if (!ts || !/^\d{9,11}(\.\d+)?$/.test(ts)) return null;
  const ms = Math.round(Number(ts) * 1000);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

const between = (s: string, tag: string): string | null => {
  const open = s.indexOf(`<${tag}>`);
  if (open < 0) return null;
  const start = open + tag.length + 2;
  const close = s.indexOf(`</${tag}>`, start);
  return s.slice(start, close < 0 ? undefined : close);
};

/**
 * A recorded turn as console lines: the user's message, then the agent's answer.
 *
 * The record is written once per turn, after the reply, so its time is the
 * agent line's. The user line's own time is the Slack message ts its envelope
 * carries (`inbound_ts`); a line with neither (a cron or wake envelope, an
 * older row with only a day) is marked `dateOnly` rather than shown with a
 * clock time it never had.
 */
export function turnLines(row: MemoryTimelineRow, surface: string = surfaceOfSession()): SessionHistoryItem[] {
  const day = Date.parse(`${row.date}T00:00:00Z`) || 0;
  const detail = row.detail ?? "";
  const userRaw = between(detail, "user") ?? row.summary ?? "";
  const agentRaw = between(detail, "assistant") ?? "";
  const out: SessionHistoryItem[] = [];
  const user = parseUserLine(userRaw);
  if (user.text) {
    const when = user.at !== undefined ? { at: user.at } : { at: row.createdAt ?? day, dateOnly: true };
    out.push({ id: `${row.id}:user`, ...when, who: "user", ...(user.name ? { name: redactSecrets(user.name) } : {}), text: redactSecrets(user.text), surface });
  }
  const agent = agentRaw.trim();
  if (agent) {
    const when = row.createdAt != null ? { at: row.createdAt } : { at: day, dateOnly: true };
    out.push({ id: `${row.id}:agent`, ...when, who: "agent", text: redactSecrets(agent), surface });
  }
  return out;
}

/**
 * One page of a session's history, oldest first: the `limit` turns recorded
 * before the row id `before` (the newest turns when absent). `nextCursor`
 * pages further back.
 */
export async function sessionHistory(
  row: Pick<SessionRow, "id" | "persona_id">,
  memory: MemoryBrowser,
  opts: { before?: number; limit: number },
): Promise<SessionHistoryResponse> {
  if (!memory.timeline) return { items: [], nextCursor: null, note: "this deployment's memory cannot list conversation records" };
  const slug = conversationSlug(row.id);
  let rows: MemoryTimelineRow[] = [];
  for (const source of agentSourcesFor(row.persona_id)) {
    rows = await memory.timeline(source, slug, MAX_ROWS);
    if (rows.length > 0) break;
  }
  const ordered = [...rows].sort((a, b) => a.id - b.id);
  const older = opts.before === undefined ? ordered : ordered.filter((r) => r.id < opts.before!);
  const page = older.slice(-opts.limit);
  // gbrain answered its cap: older turns exist past it and cannot be paged to.
  const capped = rows.length >= MAX_ROWS;
  const nextCursor = older.length > page.length && page.length > 0 ? String(page[0]!.id) : null;
  return {
    items: page.flatMap((r) => turnLines(r)),
    nextCursor,
    ...(capped && nextCursor === null ? { note: `only the latest ${MAX_ROWS} turns of this session can be shown; older turns are not` } : {}),
  };
}

/** Timeline rows a memory page returns. */
export const MEMORY_ENTRIES_MAX = 200;

/** One timeline row for the memory page: a recorded turn's two sides, else a note. */
export function memoryEntry(row: MemoryTimelineRow): MemoryEntryView {
  const detail = row.detail ?? "";
  const isTurn = between(detail, "user") !== null || between(detail, "assistant") !== null;
  const lines: MemoryEntryLine[] = isTurn
    ? turnLines(row).map((l) => ({ who: l.who === "agent" ? "agent" : "user", ...(l.name ? { name: l.name } : {}), text: l.text }))
    : [row.summary, detail]
        .map((t) => t.trim())
        .filter((t, i, all) => t !== "" && all.indexOf(t) === i)
        .map((t) => ({ who: "note", text: redactSecrets(t) }));
  return { id: row.id, date: row.date, at: row.createdAt, lines };
}

/**
 * A memory page's timeline rows, oldest first, for the console. The engine
 * keeps these in their own table, so the page's `timeline` text is empty for
 * them. A failed read costs the rows, never the page.
 */
export async function memoryEntries(memory: MemoryBrowser, store: string, slug: string): Promise<{ entries: MemoryEntryView[]; entriesCapped: boolean }> {
  if (!memory.timeline) return { entries: [], entriesCapped: false };
  let rows: MemoryTimelineRow[];
  try {
    rows = await memory.timeline(store, slug, MEMORY_ENTRIES_MAX + 1);
  } catch (e) {
    console.error(`[panel] could not read a memory page's timeline: ${e instanceof Error ? e.name : typeof e}`);
    return { entries: [], entriesCapped: false };
  }
  const ordered = [...rows].sort((a, b) => a.id - b.id);
  return { entries: ordered.slice(-MEMORY_ENTRIES_MAX).map(memoryEntry), entriesCapped: ordered.length > MEMORY_ENTRIES_MAX };
}
