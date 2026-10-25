/**
 * The per-turn `<memory-context>` block (phase C §8.4): what the agent should
 * have in mind for this one message without having to ask for it.
 *
 *   <profile>           the speaker's own profile page (`profile`), when the
 *                       scope names their profile source;
 *   <lessons>           the agent's `self/lessons`, when its slice is readable;
 *   <open-commitments>  open `commitment` pages, in any readable source,
 *                       whose promiser or beneficiary is the speaker or whose
 *                       thread is this thread, newest `as_of` first, at most 10;
 *   <channel-notes>     `shared/channels/<channel>`, when `shared` is readable.
 *
 * Every read is limited to ONE source of the given scope (as memory_about
 * does), so the block never reads wider than the turn's own KB scope, and a
 * page tagged superseded in its source is left out. Each section is cut to
 * its limit and the whole block to TURN_CONTEXT_LIMITS.total, dropping the
 * oldest commitments first. Bounded in time too: past `timeoutMs`, or on any
 * error, there is no block (null) and the turn goes ahead without it.
 * No LLM calls (phase C non-goal).
 */
import type { BrainScope } from "../knowledge/scope";
import { SHARED_SOURCE } from "../knowledge/scope";
import { readPageRecord } from "../knowledge/memory-pages";
import { getPageOrNull, supersededSlugs, type BrainOpCall } from "../knowledge/memory-trail";

export const TURN_CONTEXT_LIMITS = { total: 8000, profile: 2000, lessons: 2500, channel: 1500 };
export const TURN_CONTEXT_TIMEOUT_MS = 1500;

/** At most this many open commitments, newest first. */
const MAX_COMMITMENTS = 10;
/** Max commitment pages listed per source. */
const COMMITMENT_LIST_LIMIT = 500;
/** One commitment's line, at most. */
const COMMITMENT_LINE_LIMIT = 500;

export interface TurnMemoryDeps {
  call(op: string, params: object, scope: BrainScope): Promise<unknown>;
  /** The KB read scope resolved for this message's sender. */
  scope: BrainScope;
  /** The agent's own slice (`agent-<id>`), where `self/lessons` lives. */
  agentSource: string;
  /** Slack user id of the message's sender. */
  speaker: string;
  /** `<channel>:<threadTs>`, as a commitment's `thread` field names it. */
  threadKey: string;
  channelId: string;
  timeoutMs?: number;
  /** Today, for marking a commitment whose date `due` has passed. */
  now?: () => Date;
}

const only = (scope: BrainScope, source: string): BrainScope => ({ ...scope, sourceId: source, allowedSources: [source] });

/** Section and block tags written inside page text would let a page close
 *  the block or fake a section; they are shown escaped instead. */
const TAGS = /<(\/?)(memory-context|profile|lessons|open-commitments|channel-notes|channel)(?=[\s>/]|$)/gi;
const neutralize = (s: string): string => s.replace(TAGS, "&lt;$1$2");

const cut = (s: string, limit: number): string => (s.length <= limit ? s : s.slice(0, limit - 1) + "…");

/** A page's body when it is current (not tagged superseded in `source`), else null. */
async function currentBody(call: BrainOpCall, scope: BrainScope, source: string, slug: string): Promise<string | null> {
  const [tagged, raw] = await Promise.all([supersededSlugs(call, scope, [source]), getPageOrNull(call, slug, only(scope, source))]);
  if (tagged.has(slug)) return null;
  const pg = readPageRecord(raw);
  if (!pg || pg.superseded) return null;
  const body = pg.body.trim();
  return body ? body : null;
}

interface Commitment {
  slug: string;
  asOf: string;
  line: string;
}

/** The speaker as a promiser/beneficiary value: the bare id, `@id` or a `<@id>` mention. */
function names(value: string | undefined, speaker: string): boolean {
  if (value === undefined) return false;
  const v = value.trim();
  return v === speaker || v === `@${speaker}` || v.includes(`<@${speaker}>`);
}

async function commitmentsIn(call: BrainOpCall, scope: BrainScope, source: string, d: TurnMemoryDeps, today: string): Promise<Commitment[]> {
  const one = only(scope, source);
  const [rows, tagged] = await Promise.all([
    call("list_pages", { type: "commitment", limit: COMMITMENT_LIST_LIMIT }, one),
    supersededSlugs(call, scope, [source]),
  ]);
  if (!Array.isArray(rows)) return [];
  const slugs = rows
    .map((r) => (r as { slug?: unknown } | null)?.slug)
    .filter((s): s is string => typeof s === "string" && !tagged.has(s));
  const pages = await Promise.all(slugs.map(async (slug) => ({ slug, pg: readPageRecord(await getPageOrNull(call, slug, one)) })));
  const out: Commitment[] = [];
  for (const { slug, pg } of pages) {
    if (!pg || pg.superseded) continue;
    const m = pg.meta;
    if (m.type !== "commitment" || m.status !== "open") continue;
    if (!names(m.promiser, d.speaker) && !names(m.beneficiary, d.speaker) && m.thread?.trim() !== d.threadKey) continue;
    const asOf = m.as_of ?? "";
    const what = pg.body.replace(/\s+/g, " ").trim() || slug;
    const facts = [
      m.promiser ? `promiser ${m.promiser}` : null,
      m.beneficiary ? `for ${m.beneficiary}` : null,
      m.due ? `due ${m.due}${/^\d{4}-\d{2}-\d{2}$/.test(m.due) && m.due < today ? " (overdue)" : ""}` : null,
      m.thread ? `thread ${m.thread}` : null,
      asOf ? `as of ${asOf}` : null,
    ].filter((x): x is string => x !== null);
    out.push({ slug, asOf, line: cut(neutralize(`- ${what} (${facts.join(", ")})`), COMMITMENT_LINE_LIMIT) });
  }
  return out;
}

const section = (name: string, inner: string): string => `<${name}>\n${inner}\n</${name}>`;

async function build(d: TurnMemoryDeps): Promise<string | null> {
  const call = d.call as BrainOpCall;
  const { scope } = d;
  const readable = new Set(scope.allowedSources);
  const today = (d.now ?? (() => new Date()))().toISOString().slice(0, 10);

  const [profile, lessons, commitments, channel] = await Promise.all([
    scope.profileSource && readable.has(scope.profileSource) ? currentBody(call, scope, scope.profileSource, "profile") : null,
    readable.has(d.agentSource) ? currentBody(call, scope, d.agentSource, "self/lessons") : null,
    Promise.all([...readable].map((s) => commitmentsIn(call, scope, s, d, today))).then((all) =>
      all.flat().sort((a, b) => (a.asOf === b.asOf ? a.slug.localeCompare(b.slug) : a.asOf < b.asOf ? 1 : -1)).slice(0, MAX_COMMITMENTS),
    ),
    readable.has(SHARED_SOURCE) ? currentBody(call, scope, SHARED_SOURCE, `shared/channels/${d.channelId.toLowerCase()}`) : null,
  ]);

  const head = [
    profile ? section("profile", cut(neutralize(profile), TURN_CONTEXT_LIMITS.profile)) : null,
    lessons ? section("lessons", cut(neutralize(lessons), TURN_CONTEXT_LIMITS.lessons)) : null,
  ];
  const tail = channel ? section("channel-notes", cut(neutralize(channel), TURN_CONTEXT_LIMITS.channel)) : null;
  const render = (kept: Commitment[]): string =>
    [...head, kept.length ? section("open-commitments", kept.map((c) => c.line).join("\n")) : null, tail]
      .filter((x): x is string => x !== null)
      .join("\n");

  // Newest first: dropping from the end drops the oldest.
  const kept = [...commitments];
  let text = render(kept);
  while (text.length > TURN_CONTEXT_LIMITS.total && kept.length > 0) {
    kept.pop();
    text = render(kept);
  }
  return text ? text.slice(0, TURN_CONTEXT_LIMITS.total) : null;
}

/**
 * The inner text of this message's `<memory-context>` block (without the
 * tags), or null when there is nothing to show, the reads take longer than
 * `timeoutMs`, or any read fails. A failure logs one warning naming only the
 * error's kind, never page text.
 */
export async function buildTurnMemoryContext(deps: TurnMemoryDeps): Promise<string | null> {
  const ms = deps.timeoutMs ?? TURN_CONTEXT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    const r = await Promise.race([build(deps), timeout]);
    if (r === "timeout") {
      console.warn(`[memory-context] skipped: brain reads took longer than ${ms}ms`);
      return null;
    }
    return r;
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    const kind = typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : e instanceof Error ? e.name : typeof e;
    console.warn(`[memory-context] skipped: a brain read failed (${kind})`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
