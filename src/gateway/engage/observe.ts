import { env } from "../../config/env";
import { m as metric } from "../../metrics";
import { channelTrustFor } from "../../knowledge/scope";
import { getPersonaRegistry } from "../../persona/registry";
import { COMMON_WORD_DENYLIST, foldAlias } from "../../persona/aliases";
import { trustSoulFor } from "../../soul/per-persona";
import { lastSpeakers, type LastSpeaker } from "./last-speaker";
import { aliasesFor, engageFor } from "./setting";
import { MAX_TEXT, runTiers, type TierFacts, type TierResult } from "./tiers";

/** The reads of the last-speaker record may not hold the handler longer than this; a slow Redis reads as no record. */
export const RECORD_READ_BUDGET_MS = 100;
/** Contribute-only root band (phase 0 counts it; the timers belong to phase 1). */
const ROOT_MIN_LENGTH = 30;
const ROOT_DEBOUNCE_MS = 60_000;
/** At most this many other personas are looked at for "another agent spoke last". */
const MAX_PEEKS = 8;

/**
 * Reasons that settle a message before the record matters (the plan's tier 0
 * text rules). A message settled by one of them never reads or clears the
 * record: a bot post, a join, an ack or a message to a colleague is not the
 * follower of the agent's answer.
 */
const SETTLED_WITHOUT_RECORD: ReadonlySet<string> = new Set([
  "restricted", "subtype", "bot_author", "lock_1on1", "lock_mention_only", "lock_disengaged",
  "names_other_person", "names_group", "names_other_agent", "vocative_other", "ack",
]);

export interface ObserveInput {
  /** The Slack message event. */
  event: any;
  /** The persona this copy speaks for (absent: the default persona). */
  personaId?: string;
  /** The Slack app id this copy arrived through. */
  appId?: string;
  /** This app's bot user id. */
  botId: string;
  /** The agent's cached Slack display name (never fetched here), when it is the agent's own bot. */
  botName?: string;
  locks: { oneOnOne: boolean; mentionOnly: boolean; disengaged: boolean };
  threadEngaged: boolean;
  /** Where the observation was made, for the log line. */
  site: "drop" | "channel_session";
}

const timeout = <T>(ms: number, v: T): Promise<T> => new Promise((r) => setTimeout(() => r(v), ms).unref?.());

/** A name worth matching: letters and digits, 3 to 32, not a common word. */
const usableName = (n: unknown): n is string => typeof n === "string" && /^[\p{L}\p{N}]{3,32}$/u.test(n.normalize("NFKC")) && !COMMON_WORD_DENYLIST.has(foldAlias(n));

async function readRecords(channel: string, thread: string | null, own: string, others: string[]): Promise<{ own: LastSpeaker | null; other: LastSpeaker | null }> {
  const none = { own: null, other: null };
  try {
    const store = lastSpeakers();
    const read = Promise.all([
      store.take({ channel, thread, persona: own }),
      Promise.all(others.slice(0, MAX_PEEKS).map((persona) => store.peek({ channel, thread, persona }))),
    ]).then(([o, peeks]) => ({
      own: o,
      other: peeks.filter((r): r is LastSpeaker => !!r).sort((a, b) => Number.parseFloat(b.ts) - Number.parseFloat(a.ts))[0] ?? null,
    }));
    return await Promise.race([read, timeout(RECORD_READ_BUDGET_MS, none)]);
  } catch {
    return none;
  }
}

/** The facts for the ladder from a Slack event, with the records already read. */
export function factsFromEvent(i: ObserveInput, level: "addressed" | "contribute", restricted: boolean, own: LastSpeaker | null, other: LastSpeaker | null): TierFacts {
  const e = i.event;
  const me = i.personaId ?? "default";
  const self = new Set<string>([i.botId].filter(Boolean));
  const p = i.personaId ? getPersonaRegistry().lookupByName(i.personaId) : null;
  if (p?.slackUserId) self.add(p.slackUserId);
  const others = new Set(
    getPersonaRegistry().list().map((x) => foldAlias(x.name)).filter((n) => n && n !== foldAlias(me) && n !== "default"),
  );
  const isRoot = !e.thread_ts || e.thread_ts === e.ts;
  const raw = String(e.text ?? "");
  if (raw.length > MAX_TEXT) metric.engageTruncatedTotal.inc();
  const displayNames = [p?.config?.name, i.botName].filter(usableName);
  return {
    text: raw.length > MAX_TEXT ? raw.slice(0, MAX_TEXT) : raw,
    subtype: e.subtype ?? null,
    authorIsBot: Boolean(e.bot_id || e.bot_profile),
    authorId: String(e.user ?? ""),
    selfUserIds: self,
    hasFiles: Array.isArray(e.files) && e.files.length > 0,
    isThreadReply: !isRoot,
    isRoot,
    threadEngaged: i.threadEngaged,
    level,
    restricted,
    locks: i.locks,
    lastSpeaker: own,
    otherSpeaker: other,
    agent: { name: me, aliases: aliasesFor(i.personaId), displayNames, ...(i.appId ? { app: i.appId } : {}) },
    otherAgents: others,
    // STUB (stage 3 or phase 1): there is no users cache yet, so a same-named human is never detected and
    // "Name, ..." counts as tier 1 run even when a colleague shares the name.
    sameNamedHuman: () => false,
    nowMs: Date.now(),
    windowMs: env.engageWindowMinutes() * 60_000,
    // STUB (stage 3 or phase 1): telling that two humans took turns needs a history read, which phase 0 never makes.
    humansAlternated: false,
    rootBand: { minLength: ROOT_MIN_LENGTH, debounceMs: ROOT_DEBOUNCE_MS },
  };
}

/**
 * Phase 0 shadow: run the ladder on a message the agent is not going to
 * answer, count what it would have done, and log one line. Counters only: no
 * adapter, no history read, and nothing here changes what the agent does.
 *
 * At level `mention` (the default) it returns before reading anything. The
 * record is read (and cleared) only for a human conversational message the
 * text rules did not settle. It never throws, and its one wait is bounded.
 *
 * Each app's copy of a message observes it once, so with several apps in a
 * channel the counter counts per copy, not per message.
 */
export async function observeEngage(i: ObserveInput): Promise<TierResult | null> {
  try {
    const channel: string = i.event?.channel;
    if (!channel) return null;
    const setting = engageFor(i.personaId, channel);
    if (setting.level === "mention") return null;
    const level = setting.level;
    const restricted = channelTrustFor(channel, trustSoulFor(i.personaId)) === "unknown";
    let r = runTiers(factsFromEvent(i, level, restricted, null, null));
    if (!SETTLED_WITHOUT_RECORD.has(r.reason)) {
      const thread: string | null = i.event.thread_ts && i.event.thread_ts !== i.event.ts ? i.event.thread_ts : null;
      const me = i.personaId ?? "default";
      const others = [...new Set([...getPersonaRegistry().list().map((x) => x.name), "default"])].filter((n) => n !== me);
      const rec = await readRecords(channel, thread, me, others);
      if (rec.own || rec.other) r = runTiers(factsFromEvent(i, level, restricted, rec.own, rec.other));
    }
    const tier = r.action === "existing" ? "existing" : String(r.tier);
    metric.engageTotal.inc({ tier, outcome: r.action, level });
    console.log(`[engage] phase0 channel=${channel} level=${level} tier=${tier} would=${r.action} reason=${r.reason}`);
    return r;
  } catch (err) {
    try {
      console.warn(`[engage] phase0 observe failed: ${(err as Error).message}`);
    } catch {
      /* nothing */
    }
    return null;
  }
}
