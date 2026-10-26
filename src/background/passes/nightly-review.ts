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
import type { AppRef } from "../../gateway/core/transport";

export interface NightlyDeps {
  runner: RunnerDeps;
  /** Brain reads for collecting the day, one source per call. */
  call: BrainOpCall;
  /** Every brain source id (sources_list). */
  listSources: () => Promise<string[]>;
  /** Seam (tests): the runner. */
  run?: typeof runPass;
  /** Posts a run-as pass's proposals to that person's DM, once per run. Absent: they wait unseen until they expire. */
  deliver?: PersonDelivery;
}

/** Delivery of one pass run's proposals to the person it ran as (proposal-cards.ts postPersonProposals). */
export type PersonDelivery = (a: { agentId: string; userId: string; app?: AppRef; ids: string[] }) => Promise<void>;

/**
 * After a pass that ran as a person: post the proposals it queued to that
 * person's DM, in one message. Agent-scope runs propose only to the manager
 * (the weekly digest), so nothing is posted for them. A failure is logged;
 * the proposals stay open until they expire.
 */
export async function deliverRunProposals(deliver: PersonDelivery | undefined, a: { agentId: string; scope: PassScope; app?: AppRef; proposed?: string[]; tag: string }): Promise<void> {
  if (a.scope.kind !== "user" || !a.proposed || a.proposed.length === 0) return;
  if (!deliver) {
    console.warn(`${a.tag}: ${a.proposed.length} proposal(s) for ${a.scope.userId} not posted: no Slack to post through`);
    return;
  }
  try {
    // The run's own session's app: on a multi-app gateway a team id alone never picks one.
    await deliver({ agentId: a.agentId, userId: a.scope.userId, ...(a.app ? { app: a.app } : {}), ids: a.proposed });
  } catch (e) {
    console.error(`${a.tag}: could not post ${a.proposed.length} proposal(s) to ${a.scope.userId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** A timeline row as get_timeline returns it (gbrain adds created_at). */
export type DayRow = TimelineRow & { created_at?: unknown };

/** Most transcript characters one pass is handed; older turns beyond it are dropped. */
export const NIGHTLY_MAX_TRANSCRIPT_CHARS = 120_000;
/** Most sessions one review reads. */
export const MAX_SESSIONS = 2000;
/** gbrain's get_timeline ceiling (newest dates first, ties in no set order). */
export const TIMELINE_CEILING = 100;
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
const SLACK_SOURCE_ATTR = /\ssource="slack"/;
/** A skill invocation's body (agent-authored skill text; `<skill-args>` is not matched). */
const SKILL_BLOCK = /<skill(?=[\s>])[^>]*>[\s\S]*?(?:<\/skill>|$)/g;
const SKILL_ARGS_TAG = /<\/?skill-args>/g;
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
    // Only a Slack envelope names an author: Slack sends typed `<` as `&lt;`,
    // so its body cannot forge one. Any other surface (the panel) is system text.
    const author = SLACK_SOURCE_ATTR.test(m[1]!) ? USER_ID_ATTR.exec(m[1]!)?.[1] || SYSTEM_AUTHOR : SYSTEM_AUTHOR;
    const body = m[2]!;
    // A skill's body is the skill's text, not the person's words; its args are theirs.
    for (const skill of body.match(SKILL_BLOCK) ?? []) turns.push({ at, author: SYSTEM_AUTHOR, text: skill.trim() });
    const text = body.replace(SKILL_BLOCK, "").replace(SKILL_ARGS_TAG, "").trim();
    if (text) turns.push({ at, author, text });
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

/** Keep the newest turns that fit NIGHTLY_MAX_TRANSCRIPT_CHARS (shared with the quiet-moment pass). */
export function capped(turns: TranscriptTurn[], tag: string): TranscriptTurn[] {
  let size = 0;
  let i = turns.length;
  while (i > 0 && size + turns[i - 1]!.text.length <= NIGHTLY_MAX_TRANSCRIPT_CHARS) size += turns[--i]!.text.length;
  if (i > 0) console.warn(`${tag}: transcript over ${NIGHTLY_MAX_TRANSCRIPT_CHARS} chars; the ${i} oldest turn(s) are left out`);
  return turns.slice(i);
}

export interface PersonDay {
  userId: string;
  teamId: string;
  /** The Slack app of their most recently touched session here (cards go out as it). */
  app?: AppRef;
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
  if (sessions.length >= MAX_SESSIONS) console.warn(`${tag}: over ${MAX_SESSIONS} sessions since ${day}; only the ${MAX_SESSIONS} touched most recently are read`);
  const teamOf = new Map(sessions.map((s) => [conversationSlug(s.id), s.slack_team_id ?? ""]));
  // Sessions come most recently touched first: the first app seen per slug is the thread's own.
  const appOf = new Map(sessions.map((s) => [conversationSlug(s.id), s.slack_app_id ?? null]));
  const only = (source: string): BrainScope => ({ clientId: group.agentId, sourceId: source, allowedSources: [source] });
  const timeline = async (source: string, slug: string): Promise<DayRow[]> => {
    const rows = await deps.call("get_timeline", { slug }, only(source));
    if (!Array.isArray(rows)) return [];
    if (rows.length >= TIMELINE_CEILING) {
      console.warn(`${tag}: ${slug} in ${source} returned ${rows.length} timeline entries, gbrain's limit; some of ${day}'s turns may be missing`);
    }
    return rows as DayRow[];
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
      const own = ownTurns(turns, userId);
      if (own.length < turns.length) console.warn(`${tag}: ${turns.length - own.length} turn(s) by someone else in ${source} are left out`);
      const teamId = teamOf.get(slug)!;
      const key = `${userId}\n${teamId}`;
      const apiAppId = appOf.get(slug) ?? null;
      const person = users.get(key) ?? { userId, teamId, turns: [], ...(apiAppId ? { app: { apiAppId, teamId } } : teamId ? { app: { teamId } } : {}) };
      if (!person.app?.apiAppId && apiAppId) person.app = { apiAppId, teamId };
      person.turns.push(...own);
      users.set(key, person);
    }
  }
  return { agent, users: [...users.values()] };
}

/** Only that person's own turns, the agent's and runtime text: a pass never mixes two people. */
export function ownTurns(turns: TranscriptTurn[], userId: string): TranscriptTurn[] {
  return turns.filter((t) => t.author === userId || t.author === AGENT_AUTHOR || t.author === SYSTEM_AUTHOR);
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
 * `signal` (shutdown) stops the pass in flight and starts no further one: the
 * slot is already claimed, so the people not reviewed are logged and lost for
 * that day.
 */
export async function runNightlyReview(r: AgentGroup & { slot: string; signal?: AbortSignal }, deps: NightlyDeps): Promise<NightlyResult[]> {
  const day = reviewedDay(r.slot);
  const tag = `[background] agent=${r.agentId} pass=nightly-review`;
  const { agent, users } = await collectDay(r, day, deps);
  const run = deps.run ?? runPass;
  const out: NightlyResult[] = [];
  const queue: Array<{ scope: PassScope; app?: AppRef; prompt: () => string; transcripts: TranscriptTurn[] }> = [];
  if (agent.length > 0) {
    queue.push({ scope: { kind: "agent" }, prompt: () => renderPassPrompt("nightly-review-agent", { DAY: day, PROPOSALS_SLUG, LESSONS_SLUG }), transcripts: agent });
  }
  for (const u of users) {
    queue.push({ scope: { kind: "user", userId: u.userId, teamId: u.teamId }, ...(u.app ? { app: u.app } : {}), prompt: () => renderPassPrompt("nightly-review-user", { DAY: day, USER_ID: u.userId }), transcripts: u.turns });
  }
  const label = (s: PassScope) => (s.kind === "user" ? `user:${s.userId}` : "agent");
  for (const [i, q] of queue.entries()) {
    if (r.signal?.aborted) {
      console.log(`${tag}: shutting down; not reviewed on ${day}: ${queue.slice(i).map((x) => label(x.scope)).join(", ")}`);
      break;
    }
    const spec: PassSpec = {
      pass: "nightly-review",
      personaId: r.personaId,
      agentId: r.agentId,
      scope: q.scope,
      prompt: q.prompt(),
      transcripts: capped(q.transcripts, tag),
      ...(r.signal ? { signal: r.signal } : {}),
    };
    const res = await run(spec, deps.runner);
    out.push({ scope: label(q.scope), outcome: res.outcome });
    await deliverRunProposals(deps.deliver, { agentId: r.agentId, scope: q.scope, ...(q.app ? { app: q.app } : {}), proposed: res.proposed, tag });
  }
  if (queue.length === 0) console.log(`${tag}: no conversations on ${day}; nothing to review`);
  return out;
}
