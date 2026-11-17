import { env } from "../../config/env";
import { m as metric } from "../../metrics";
import { channelTrustFor } from "../../knowledge/scope";
import { getPersonaRegistry } from "../../persona/registry";
import { COMMON_WORD_DENYLIST, foldAlias } from "../../persona/aliases";
import { trustSoulFor } from "../../soul/per-persona";
import { lastSpeakers, type LastSpeaker } from "./last-speaker";
import { aliasesFor, engageFor } from "./setting";
import { usersCache, type UsersCache, type UsersSnapshot } from "./users";
import { engageState } from "./budget";
import { plan, scheduleShadow, type ShadowDeps } from "./shadow";
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
  /** The Slack team of the delivery, to find colleagues who share the agent's name. */
  teamId?: string;
  /** Starts the team's names lookup when it is missing or stale (never awaited). Without one the lookup stays unknown. */
  loadUsers?: () => Promise<UsersSnapshot>;
  /** Test seam: the users cache. */
  users?: UsersCache;
  /** Phase 1: what the shadow classifier needs. Absent: phase 0 only (counters and the one line). */
  shadow?: ShadowDeps;
  /**
   * More than one persona posts through this app's bot, so a root whose author is
   * the bot alone cannot be told to be this persona's (the root is then not read as the agent's own).
   */
  sharedBot?: boolean;
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
export function factsFromEvent(i: ObserveInput, level: "addressed" | "contribute", restricted: boolean, own: LastSpeaker | null, other: LastSpeaker | null, alternated = false): TierFacts {
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
  // The root is the agent's own when Slack says its author is this app's bot (and no other persona shares that bot)
  // or this persona's own user. An absent field, or a root by another persona, is not.
  const parent = typeof e.parent_user_id === "string" ? e.parent_user_id : "";
  const parentPersona = parent ? getPersonaRegistry().lookupByUserId(parent) : null;
  const rootIsAgent = !isRoot && !!parent && (parentPersona ? foldAlias(parentPersona.name) === foldAlias(me) : parent === i.botId && !i.sharedBot);
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
    // A colleague who shares the name sends "Name, ..." to the classifier. Unknown (no snapshot yet) reads as shared.
    sameNamedHuman: (folded) => (i.users ?? usersCache()).sameNamed(i.teamId, folded),
    nowMs: Date.now(),
    windowMs: env.engageWindowMinutes() * 60_000,
    // Known only when an earlier classifier input read the thread (a flag it left behind); otherwise false.
    humansAlternated: alternated,
    rootIsAgent,
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
    if (i.loadUsers) (i.users ?? usersCache()).ensure(i.teamId, i.loadUsers);
    const restricted = channelTrustFor(channel, trustSoulFor(i.personaId)) === "unknown";
    let r = runTiers(factsFromEvent(i, level, restricted, null, null));
    if (!SETTLED_WITHOUT_RECORD.has(r.reason)) {
      const thread: string | null = i.event.thread_ts && i.event.thread_ts !== i.event.ts ? i.event.thread_ts : null;
      const me = i.personaId ?? "default";
      const others = [...new Set([...getPersonaRegistry().list().map((x) => x.name), "default"])].filter((n) => n !== me);
      const rec = await readRecords(channel, thread, me, others);
      if (rec.own || rec.other) {
        const alt = rec.own && thread ? await Promise.race([(i.shadow?.state ?? engageState()).alternated(channel, thread).catch(() => false), timeout(RECORD_READ_BUDGET_MS, false)]) : false;
        r = runTiers(factsFromEvent(i, level, restricted, rec.own, rec.other, alt));
      }
    }
    const tier = r.action === "existing" ? "existing" : String(r.tier);
    metric.engageTotal.inc({ tier, outcome: r.action, level });
    const p = plan(r, i.shadow);
    console.log(`[engage] phase0 channel=${channel} level=${level} tier=${tier} would=${r.action} reason=${r.reason} classifier=${"skip" in p ? `skip:${p.skip}` : "queued"}`);
    if (!("skip" in p) && i.shadow) {
      // After the handler has what it needs: the job runs on its own, with its own deadline.
      scheduleShadow(
        {
          channel,
          ts: String(i.event.ts),
          thread: i.event.thread_ts && i.event.thread_ts !== i.event.ts ? String(i.event.thread_ts) : null,
          author: String(i.event.user ?? ""),
          level,
          persona: i.personaId,
          app: i.appId,
          result: r,
        },
        i.shadow,
      );
    }
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
