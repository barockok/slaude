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
 * page tagged superseded in its source is left out (the superseded set is
 * read once per source). `kb-*` sources are operator wikis, never memory, so
 * they are not scanned for commitments. Each section is cut to its limit and
 * the whole block to TURN_CONTEXT_LIMITS.total, dropping the oldest
 * commitments first.
 *
 * With memory places on (`placesOn`), each section has its own slice of the deadline and a late or failed section
 * is dropped alone (see buildSliced); otherwise one late read drops the whole block, as before.
 *
 * Bounded in time and load: past `timeoutMs`, or on any error, there is no
 * block (null) and the turn goes ahead without it; once the deadline passes
 * no further brain call starts (calls already in flight finish on their own),
 * and at most GET_PAGE_CONCURRENCY `get_page` calls run at once.
 * No LLM calls (phase C non-goal).
 */
import type { BrainScope } from "../knowledge/scope";
import { AGENT_SOURCE, SHARED_SOURCE } from "../knowledge/scope";
import { parseThread } from "../proactive/due";
import { readPageRecord } from "../knowledge/memory-pages";
import { ENVELOPE_TAG_ALTERNATION } from "./envelope-tags";
import { getPageOrNull, supersededSlugs, type BrainOpCall } from "../knowledge/memory-trail";
import { isBrainNotOpen } from "../knowledge/brain-work";

export const TURN_CONTEXT_LIMITS = { total: 8000, profile: 2000, lessons: 2500, channel: 1500 };
export const TURN_CONTEXT_TIMEOUT_MS = 1500;

/** At most this many open commitments, newest first. */
const MAX_COMMITMENTS = 10;
/** Max commitment pages listed per source. */
const COMMITMENT_LIST_LIMIT = 500;
/** One commitment's line, at most. */
const COMMITMENT_LINE_LIMIT = 500;
/** At most this many get_page calls in flight per block. */
export const GET_PAGE_CONCURRENCY = 4;

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
  /** Memory places are on for this turn (rc.46): a commitment the persona-wide slice holds is shown only here or
   *  when its `thread` names no other channel, so another place's promise does not appear in this one. */
  placesOn?: boolean;
  timeoutMs?: number;
  /** Today, for marking a commitment whose date `due` has passed. */
  now?: () => Date;
}

const only = (scope: BrainScope, source: string): BrainScope => ({ ...scope, sourceId: source, allowedSources: [source] });

/** Every envelope tag the runtime gives meaning to, and this block's own
 *  sections: written inside page text, one would let a page close the block,
 *  fake a section or pose as a runtime message, so they are shown escaped. */
const TAGS = new RegExp(`<(/?)(${ENVELOPE_TAG_ALTERNATION})(?=[\\s>/]|$)`, "gi");
const neutralize = (s: string): string => s.replace(TAGS, "&lt;$1$2");

const cut = (s: string, limit: number): string => (s.length <= limit ? s : s.slice(0, limit - 1) + "…");

/** The block was given up on: no further brain call may start. */
class DeadlinePassed extends Error {}

/**
 * One block's reads: every brain call goes through `call`, which refuses to
 * start once the deadline has passed; `get_page` calls also wait for one of
 * GET_PAGE_CONCURRENCY slots; each source's superseded set is read once.
 */
class Reads {
  #expired = false;
  #active = 0;
  #waiting: Array<() => void> = [];
  #superseded = new Map<string, Promise<Set<string>>>();
  constructor(private readonly raw: BrainOpCall, private readonly scope: BrainScope) {}

  expire(): void {
    this.#expired = true;
    for (const w of this.#waiting.splice(0)) w();
  }

  call: BrainOpCall = async (name, params, scope) => {
    if (this.#expired) throw new DeadlinePassed();
    if (name !== "get_page") return this.raw(name, params, scope);
    while (this.#active >= GET_PAGE_CONCURRENCY) {
      await new Promise<void>((r) => this.#waiting.push(r));
      if (this.#expired) throw new DeadlinePassed();
    }
    this.#active++;
    try {
      return await this.raw(name, params, scope);
    } finally {
      this.#active--;
      this.#waiting.shift()?.();
    }
  };

  superseded(source: string): Promise<Set<string>> {
    let s = this.#superseded.get(source);
    if (!s) {
      s = supersededSlugs(this.call, this.scope, [source]);
      this.#superseded.set(source, s);
    }
    return s;
  }

  page(slug: string, source: string) {
    return getPageOrNull(this.call, slug, only(this.scope, source)).then(readPageRecord);
  }
}

/** A page's body when it is current (not tagged superseded in `source`), else null. */
async function currentBody(r: Reads, source: string, slug: string): Promise<string | null> {
  const [tagged, pg] = await Promise.all([r.superseded(source), r.page(slug, source)]);
  if (tagged.has(slug) || !pg || pg.superseded) return null;
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

async function commitmentsIn(r: Reads, scope: BrainScope, source: string, d: TurnMemoryDeps, today: string): Promise<Commitment[]> {
  const [rows, tagged] = await Promise.all([
    r.call("list_pages", { type: "commitment", limit: COMMITMENT_LIST_LIMIT }, only(scope, source)),
    r.superseded(source),
  ]);
  if (!Array.isArray(rows)) return [];
  const slugs = rows
    .map((row) => (row as { slug?: unknown } | null)?.slug)
    .filter((s): s is string => typeof s === "string" && !tagged.has(s));
  const pages = await Promise.all(slugs.map(async (slug) => ({ slug, pg: await r.page(slug, source) })));
  const out: Commitment[] = [];
  for (const { slug, pg } of pages) {
    if (!pg || pg.superseded) continue;
    const m = pg.meta;
    if (m.type !== "commitment" || m.status !== "open") continue;
    if (!names(m.promiser, d.speaker) && !names(m.beneficiary, d.speaker) && m.thread?.trim() !== d.threadKey) continue;
    // The legacy persona-wide scan stays while pages move into places, minus any commitment of another boundary.
    if (d.placesOn === true && (source === d.agentSource || source === AGENT_SOURCE)) {
      const thread = parseThread(m.thread);
      if (thread && thread.channelId !== d.channelId) continue;
    }
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

/** The sections' texts to a block: newest commitments first, dropping the oldest until the whole fits. */
function assemble(profile: string | null, lessons: string | null, commitments: Commitment[], channel: string | null): string | null {
  const head = [
    profile ? section("profile", cut(neutralize(profile), TURN_CONTEXT_LIMITS.profile)) : null,
    lessons ? section("lessons", cut(neutralize(lessons), TURN_CONTEXT_LIMITS.lessons)) : null,
  ];
  const tail = channel ? section("channel-notes", cut(neutralize(channel), TURN_CONTEXT_LIMITS.channel)) : null;
  const render = (kept: Commitment[]): string =>
    [...head, kept.length ? section("open-commitments", kept.map((c) => c.line).join("\n")) : null, tail]
      .filter((x): x is string => x !== null)
      .join("\n");

  // Newest first: dropping from the end drops the oldest. The other
  // sections' limits sum well under the total, so this always fits.
  const kept = [...commitments];
  let text = render(kept);
  while (text.length > TURN_CONTEXT_LIMITS.total && kept.length > 0) {
    kept.pop();
    text = render(kept);
  }
  return text || null;
}

const readSections = (r: Reads, d: TurnMemoryDeps) => {
  const { scope } = d;
  const readable = new Set(scope.allowedSources);
  const today = (d.now ?? (() => new Date()))().toISOString().slice(0, 10);
  return {
    profile: (): Promise<string | null> => (scope.profileSource && readable.has(scope.profileSource) ? currentBody(r, scope.profileSource, "profile") : Promise.resolve(null)),
    lessons: (): Promise<string | null> => (readable.has(d.agentSource) ? currentBody(r, d.agentSource, "self/lessons") : Promise.resolve(null)),
    commitments: (): Promise<Commitment[]> =>
      Promise.all([...readable].filter((s) => !s.startsWith("kb-")).map((s) => commitmentsIn(r, scope, s, d, today))).then((all) =>
        all.flat().sort((a, b) => (a.asOf === b.asOf ? a.slug.localeCompare(b.slug) : a.asOf < b.asOf ? 1 : -1)).slice(0, MAX_COMMITMENTS),
      ),
    channel: (): Promise<string | null> => (readable.has(SHARED_SOURCE) ? currentBody(r, SHARED_SOURCE, `shared/channels/${d.channelId.toLowerCase()}`) : Promise.resolve(null)),
  };
};

async function build(r: Reads, d: TurnMemoryDeps): Promise<string | null> {
  const s = readSections(r, d);
  const [profile, lessons, commitments, channel] = await Promise.all([s.profile(), s.lessons(), s.commitments(), s.channel()]);
  return assemble(profile, lessons, commitments, channel);
}

/** Each section's share of the deadline when places are on: the commitment scan reads every source, so it gets all of it. */
export const SECTION_SLICE = { profile: 0.4, lessons: 0.4, commitments: 1, channel: 0.4 } as const;

/**
 * Memory places on (rc.47): every section has its own reads and its own slice of the deadline, and a section that is
 * late or fails is dropped alone, so one slow source no longer takes the whole block with it. A brain that is not open
 * drops every section silently; any other failure logs one line naming only the section and the error's kind.
 */
async function buildSliced(d: TurnMemoryDeps, ms: number): Promise<string | null> {
  const part = async <T>(name: string, frac: number, run: (r: Reads) => Promise<T>, empty: T): Promise<T> => {
    const reads = new Reads(d.call as BrainOpCall, d.scope);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => {
        reads.expire();
        resolve("late");
      }, Math.max(1, Math.floor(ms * frac)));
    });
    try {
      const r = await Promise.race([run(reads), late]);
      if (r === "late") {
        console.warn(`[memory-context] ${name} skipped: brain reads took longer than ${Math.floor(ms * frac)}ms`);
        return empty;
      }
      return r;
    } catch (e) {
      if (!isBrainNotOpen(e)) {
        const code = (e as { code?: unknown } | null)?.code;
        const kind = typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : e instanceof Error ? e.name : typeof e;
        console.warn(`[memory-context] ${name} skipped: a brain read failed (${kind})`);
      }
      return empty;
    } finally {
      clearTimeout(timer);
      reads.expire();
    }
  };
  const [profile, lessons, commitments, channel] = await Promise.all([
    part("profile", SECTION_SLICE.profile, (r) => readSections(r, d).profile(), null),
    part("lessons", SECTION_SLICE.lessons, (r) => readSections(r, d).lessons(), null),
    part("open-commitments", SECTION_SLICE.commitments, (r) => readSections(r, d).commitments(), [] as Commitment[]),
    part("channel-notes", SECTION_SLICE.channel, (r) => readSections(r, d).channel(), null),
  ]);
  return assemble(profile, lessons, commitments, channel);
}

/**
 * The inner text of this message's `<memory-context>` block (without the
 * tags), or null when there is nothing to show, the reads take longer than
 * `timeoutMs`, or any read fails. A failure logs one warning naming only the
 * error's kind, never page text; a brain that is not open (BrainNotOpenError)
 * is no block without a warning.
 */
export async function buildTurnMemoryContext(deps: TurnMemoryDeps): Promise<string | null> {
  const ms = deps.timeoutMs ?? TURN_CONTEXT_TIMEOUT_MS;
  if (deps.placesOn === true) return buildSliced(deps, ms);
  const reads = new Reads(deps.call as BrainOpCall, deps.scope);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      reads.expire();
      resolve("timeout");
    }, ms);
  });
  try {
    const r = await Promise.race([build(reads, deps), timeout]);
    if (r === "timeout") {
      console.warn(`[memory-context] skipped: brain reads took longer than ${ms}ms`);
      return null;
    }
    return r;
  } catch (e) {
    // The brain closed under the block (an if-open read): no brain right
    // now, not a failure worth a warning.
    if (isBrainNotOpen(e)) return null;
    const code = (e as { code?: unknown } | null)?.code;
    const kind = typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : e instanceof Error ? e.name : typeof e;
    console.warn(`[memory-context] skipped: a brain read failed (${kind})`);
    return null;
  } finally {
    clearTimeout(timer);
    // Nothing more starts once the answer is in, whichever way it came.
    reads.expire();
  }
}
