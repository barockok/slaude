/**
 * The nightly review (spec §9.1, §8.3a; ruling C): the backstop for what live
 * capture missed, over the persona-local day before the run's slot.
 *
 * The day's conversations are the `conversations/<session>` pages
 * (brain-provider.ts) of this agent's sessions touched in or after that day,
 * read one slice at a time:
 *   - the agent's own slice `agent-<id>` (channel threads): one agent-scope pass;
 *   - each person's `user-<id>` (their /1on1 threads and DMs): one pass per
 *     person and Slack team, running as that person.
 * A pass gets only its slice's timeline entries whose timestamp falls in that
 * local day, so a pass never sees two people's private slices at once.
 *
 * Each timeline entry is one turn as the memory sync stored it:
 * `<user>…</user>\n<assistant>…</assistant>`, both truncated to 800 chars. The
 * user part is the inbound envelope (`<channel … user_id="U…">text</channel>`),
 * one per coalesced message, so each envelope's `user_id` is that turn's
 * author; text outside any envelope (a runtime check, a cron prompt) is a
 * `system` turn, which can never satisfy a profile quote.
 */
import * as Sessions from "../../db/sessions";
import { localDay } from "../budget";
import { conversationSlug, orderTimeline, type TimelineRow } from "../../memory/brain-provider";
import { agentSourceId, userSourceId, type BrainScope } from "../../knowledge/scope";
import type { BrainOpCall } from "../../knowledge/memory-trail";
import { runPass, type Outcome, type PassSpec, type RunnerDeps } from "../runner";
import type { PassScope, TranscriptTurn } from "../pass-tools";
import { renderPassPrompt } from "../prompts";
import { previousDay } from "../calendar";
import { LESSONS_SLUG, PROPOSALS_SLUG } from "./lessons-upkeep";
import type { AgentGroup } from "../scheduler";

export interface NightlyDeps {
  runner: RunnerDeps;
  /** Brain reads for collecting the day, one source per call. */
  call: BrainOpCall;
  /** Every brain source id (sources_list). */
  listSources: () => Promise<string[]>;
  /** Seam (tests): the runner. */
  run?: typeof runPass;
}

/** A timeline row as get_timeline returns it (gbrain adds created_at). */
export type DayRow = TimelineRow & { created_at?: unknown };

/** Most transcript characters one pass is handed; older turns beyond it are dropped. */
export const NIGHTLY_MAX_TRANSCRIPT_CHARS = 120_000;
/** Most sessions one review reads. */
export const MAX_SESSIONS = 2000;
/** gbrain's list_pages ceiling: a full page of results may be truncated. */
const LIST_CEILING = 100;
/** The widest UTC offset (+14:00): a session touched in the local day is touched after this before UTC midnight. */
const MAX_OFFSET_MS = 14 * 3600_000;

export const SYSTEM_AUTHOR = "system";
export const AGENT_AUTHOR = "agent";

const isoOf = (v: unknown): string | null => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
};
const dateOf = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "").slice(0, 10));

const ENVELOPE = /<channel\b((?:\s+[A-Za-z_][\w-]*="[^"]*")*)\s*>([\s\S]*?)(?:<\/channel>|$)/g;
const USER_ID_ATTR = /\suser_id="([^"]*)"/;
const ASSISTANT_SPLIT = "</user>\n<assistant>";

/** One timeline row as transcript turns: each envelope's author, then the agent's reply. */
export function parseTimelineRow(row: DayRow): TranscriptTurn[] {
  const at = isoOf(row.created_at) ?? dateOf(row.date);
  const detail = typeof row.detail === "string" ? row.detail : "";
  if (!detail.startsWith("<user>")) {
    const text = (row.summary ?? "").trim();
    return text ? [{ at, author: SYSTEM_AUTHOR, text }] : [];
  }
  // Split at the first boundary: text a user typed after it reads as the
  // agent's, never the other way round (an agent turn satisfies no quote).
  const cut = detail.indexOf(ASSISTANT_SPLIT);
  const user = cut === -1 ? detail.slice(6) : detail.slice(6, cut);
  const assistant = cut === -1 ? "" : detail.slice(cut + ASSISTANT_SPLIT.length).replace(/<\/assistant>\s*$/, "");
  const turns: TranscriptTurn[] = [];
  for (const m of user.matchAll(ENVELOPE)) {
    const text = m[2]!.trim();
    if (text) turns.push({ at, author: USER_ID_ATTR.exec(m[1]!)?.[1] || SYSTEM_AUTHOR, text });
  }
  if (turns.length === 0 && user.trim()) turns.push({ at, author: SYSTEM_AUTHOR, text: user.trim() });
  if (assistant.trim()) turns.push({ at, author: AGENT_AUTHOR, text: assistant.trim() });
  return turns;
}

/** True when the row was written in the persona-local `day` (its created_at; else its UTC date). */
function inDay(row: DayRow, day: string, timeZone: string): boolean {
  const created = isoOf(row.created_at);
  return created ? localDay(new Date(created), timeZone) === day : dateOf(row.date) === day;
}

/** A thread's turns from `day`, after a marker line naming the page. */
function threadTurns(rows: DayRow[], slug: string, day: string, timeZone: string): TranscriptTurn[] {
  const turns = orderTimeline(rows).filter((r) => inDay(r, day, timeZone)).flatMap((r) => parseTimelineRow(r));
  if (turns.length === 0) return [];
  return [{ at: turns[0]!.at, author: SYSTEM_AUTHOR, text: `--- conversation ${slug} ---` }, ...turns];
}

/** Keep the newest turns that fit NIGHTLY_MAX_TRANSCRIPT_CHARS. */
function capped(turns: TranscriptTurn[], tag: string): TranscriptTurn[] {
  let size = 0;
  let i = turns.length;
  while (i > 0 && size + turns[i - 1]!.text.length <= NIGHTLY_MAX_TRANSCRIPT_CHARS) size += turns[--i]!.text.length;
  if (i > 0) console.warn(`${tag}: transcript over ${NIGHTLY_MAX_TRANSCRIPT_CHARS} chars; the ${i} oldest turn(s) are left out`);
  return turns.slice(i);
}

export interface PersonDay {
  userId: string;
  teamId: string;
  turns: TranscriptTurn[];
}

/**
 * The persona-local `day`'s transcripts for an agent group: the agent slice's
 * turns, and one transcript per person and Slack team. Sessions are this
 * group's personas' sessions touched since the day began (setStatus bumps
 * updated_at every turn).
 */
export async function collectDay(group: AgentGroup, day: string, deps: NightlyDeps): Promise<{ agent: TranscriptTurn[]; users: PersonDay[] }> {
  const tag = `[background] agent=${group.agentId} pass=nightly-review`;
  const since = Date.parse(`${day}T00:00:00Z`) - MAX_OFFSET_MS;
  const sessions = await Sessions.updatedSince(group.personaIds, since, MAX_SESSIONS);
  if (sessions.length === 0) return { agent: [], users: [] };
  if (sessions.length >= MAX_SESSIONS) console.warn(`${tag}: over ${MAX_SESSIONS} sessions since ${day}; only the ${MAX_SESSIONS} touched earliest are read`);
  const teamOf = new Map(sessions.map((s) => [conversationSlug(s.id), s.slack_team_id ?? ""]));
  const only = (source: string): BrainScope => ({ clientId: group.agentId, sourceId: source, allowedSources: [source] });
  const timeline = async (source: string, slug: string): Promise<DayRow[]> => {
    const rows = await deps.call("get_timeline", { slug }, only(source));
    return Array.isArray(rows) ? (rows as DayRow[]) : [];
  };

  const agentSrc = agentSourceId(group.agentId);
  const agent: TranscriptTurn[] = [];
  for (const slug of teamOf.keys()) agent.push(...threadTurns(await timeline(agentSrc, slug), slug, day, group.timeZone));

  const users = new Map<string, PersonDay>();
  const userSources = (await deps.listSources()).filter((s) => s.startsWith("user-")).sort();
  for (const source of userSources) {
    for (const slug of await candidatesIn(source, [...teamOf.keys()], deps.call, only(source))) {
      const turns = threadTurns(await timeline(source, slug), slug, day, group.timeZone);
      if (turns.length === 0) continue;
      const userId = ownerOf(source, turns);
      if (!userId) {
        console.warn(`${tag}: cannot tell whose slice ${source} is; ${slug} is left out`);
        continue;
      }
      // Only that person's own turns, the agent's and runtime text: a pass never mixes two people.
      const own = turns.filter((t) => t.author === userId || t.author === AGENT_AUTHOR || t.author === SYSTEM_AUTHOR);
      if (own.length < turns.length) console.warn(`${tag}: ${turns.length - own.length} turn(s) by someone else in ${source} are left out`);
      const teamId = teamOf.get(slug)!;
      const key = `${userId}\n${teamId}`;
      const person = users.get(key) ?? { userId, teamId, turns: [] };
      person.turns.push(...own);
      users.set(key, person);
    }
  }
  return { agent, users: [...users.values()] };
}

/** Of `slugs`, the ones that may have a page in `source`: all of them when the listing may be incomplete. */
async function candidatesIn(source: string, slugs: string[], call: BrainOpCall, scope: BrainScope): Promise<string[]> {
  let rows: unknown;
  try {
    rows = await call("list_pages", { type: "conversation", limit: LIST_CEILING }, scope);
  } catch {
    return slugs;
  }
  if (!Array.isArray(rows) || rows.length >= LIST_CEILING) return slugs;
  const there = new Set(rows.map((r) => (r as { slug?: unknown })?.slug));
  return slugs.filter((s) => there.has(s));
}

/**
 * The Slack user id a `user-<id>` slice belongs to (source ids are
 * lower-cased): an author whose slice it is, else the id upper-cased (Slack
 * ids are upper-case), checked against the source.
 */
function ownerOf(source: string, turns: TranscriptTurn[]): string | null {
  const fromTurn = turns.find((t) => t.author !== AGENT_AUTHOR && t.author !== SYSTEM_AUTHOR && userSourceId(t.author) === source)?.author;
  const id = fromTurn ?? source.slice("user-".length).toUpperCase();
  return userSourceId(id) === source ? id : null;
}

/** The persona-local day a slot's nightly review covers: the day before it. */
export const reviewedDay = (slot: string): string => previousDay(slot);

export interface NightlyResult {
  scope: string;
  outcome: Outcome;
}

/**
 * Run the nightly review for one agent group and slot: the agent-scope pass
 * first (it writes the lesson proposals), then one pass per person. A refused
 * budget is recorded by each pass (`skipped-budget`); nothing here stops early.
 */
export async function runNightlyReview(r: AgentGroup & { slot: string }, deps: NightlyDeps): Promise<NightlyResult[]> {
  const day = reviewedDay(r.slot);
  const tag = `[background] agent=${r.agentId} pass=nightly-review`;
  const { agent, users } = await collectDay(r, day, deps);
  const run = deps.run ?? runPass;
  const out: NightlyResult[] = [];
  const pass = async (scope: PassScope, prompt: string, transcripts: TranscriptTurn[]) => {
    const spec: PassSpec = { pass: "nightly-review", personaId: r.personaId, agentId: r.agentId, scope, prompt, transcripts: capped(transcripts, tag) };
    const res = await run(spec, deps.runner);
    out.push({ scope: scope.kind === "user" ? `user:${scope.userId}` : "agent", outcome: res.outcome });
  };
  if (agent.length > 0) {
    await pass({ kind: "agent" }, renderPassPrompt("nightly-review-agent", { DAY: day, PROPOSALS_SLUG, LESSONS_SLUG }), agent);
  }
  for (const u of users) {
    await pass({ kind: "user", userId: u.userId, teamId: u.teamId }, renderPassPrompt("nightly-review-user", { DAY: day, USER_ID: u.userId }), u.turns);
  }
  if (out.length === 0) console.log(`${tag}: no conversations on ${day}; nothing to review`);
  return out;
}
