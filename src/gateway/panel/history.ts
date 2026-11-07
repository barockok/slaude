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
import type { SessionHistoryItem, SessionHistoryResponse } from "./api-types";

/** Rows read per request: the page is cut from these. */
const MAX_ROWS = 1000;

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
export function parseUserLine(raw: string): { text: string; name?: string } {
  const s = raw.trim();
  const m = /^<(channel|cron|wake|heartbeat)\b([^>]*)>\n?([\s\S]*?)(?:\n?<\/\1>[\s\S]*)?$/.exec(s);
  if (!m) return { text: s };
  const open = m[2] ?? "";
  const text = (m[3] ?? "").trim();
  const userName = attr(open, "user_name");
  const name = userName ? unescapeAttr(userName) : undefined;
  return { text, ...(name ? { name: attr(open, "source") === "panel" ? `${name} (console)` : name } : {}) };
}

const between = (s: string, tag: string): string | null => {
  const open = s.indexOf(`<${tag}>`);
  if (open < 0) return null;
  const start = open + tag.length + 2;
  const close = s.indexOf(`</${tag}>`, start);
  return s.slice(start, close < 0 ? undefined : close);
};

/** A recorded turn as console lines: the user's message, then the agent's answer. */
export function turnLines(row: MemoryTimelineRow): SessionHistoryItem[] {
  const at = row.createdAt ?? (Date.parse(`${row.date}T00:00:00Z`) || 0);
  const detail = row.detail ?? "";
  const userRaw = between(detail, "user") ?? row.summary ?? "";
  const agentRaw = between(detail, "assistant") ?? "";
  const out: SessionHistoryItem[] = [];
  const user = parseUserLine(userRaw);
  if (user.text) out.push({ at, who: "user", ...(user.name ? { name: redactSecrets(user.name) } : {}), text: redactSecrets(user.text) });
  const agent = agentRaw.trim();
  if (agent) out.push({ at, who: "agent", text: redactSecrets(agent) });
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
  return {
    items: page.flatMap(turnLines),
    nextCursor: older.length > page.length && page.length > 0 ? String(page[0]!.id) : null,
  };
}
