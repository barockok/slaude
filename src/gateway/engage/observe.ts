import { env } from "../../config/env";
import { m as metric } from "../../metrics";
import { channelTrustFor } from "../../knowledge/scope";
import { getPersonaRegistry } from "../../persona/registry";
import { foldAlias } from "../../persona/aliases";
import { trustSoulFor } from "../../soul/per-persona";
import { lastSpeakers, type LastSpeaker } from "./last-speaker";
import { aliasesFor, engageFor } from "./setting";
import { runTiers, type TierFacts, type TierResult } from "./tiers";

/** The read of the last-speaker record may not hold the handler longer than this; a slow Redis reads as no record. */
export const RECORD_READ_BUDGET_MS = 100;
/** Contribute-only root band (phase 0 counts it; the timers belong to phase 1). */
const ROOT_MIN_LENGTH = 30;
const ROOT_DEBOUNCE_MS = 60_000;

export interface ObserveInput {
  /** The Slack message event. */
  event: any;
  /** The persona this copy speaks for (absent: the default persona). */
  personaId?: string;
  /** The Slack app id this copy arrived through. */
  appId?: string;
  /** This app's bot user id. */
  botId: string;
  locks: { oneOnOne: boolean; mentionOnly: boolean; disengaged: boolean };
  threadEngaged: boolean;
  /** Where the observation was made, for the log line. */
  site: "drop" | "channel_session";
}

const timeout = <T>(ms: number, v: T): Promise<T> => new Promise((r) => setTimeout(() => r(v), ms).unref?.());

async function readRecord(channel: string, thread: string | null): Promise<LastSpeaker | null> {
  try {
    return await Promise.race([lastSpeakers().take({ channel, thread }), timeout(RECORD_READ_BUDGET_MS, null)]);
  } catch {
    return null;
  }
}

/** The facts for the ladder from a Slack event, with the record already read. */
export function factsFromEvent(i: ObserveInput, level: "addressed" | "contribute", restricted: boolean, lastSpeaker: LastSpeaker | null): TierFacts {
  const e = i.event;
  const own = i.personaId ?? "default";
  const self = new Set<string>([i.botId].filter(Boolean));
  const p = i.personaId ? getPersonaRegistry().lookupByName(i.personaId) : null;
  if (p?.slackUserId) self.add(p.slackUserId);
  const others = new Set(
    getPersonaRegistry().list().map((x) => foldAlias(x.name)).filter((n) => n && n !== foldAlias(own) && n !== "default"),
  );
  const isRoot = !e.thread_ts || e.thread_ts === e.ts;
  return {
    text: String(e.text ?? ""),
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
    lastSpeaker,
    agent: { name: own, aliases: aliasesFor(i.personaId), ...(i.appId ? { app: i.appId } : {}) },
    otherAgents: others,
    // No users cache yet: a same-named human is not detected, so a name followed by a comma counts as tier 1.
    sameNamedHuman: () => false,
    nowMs: Date.now(),
    windowMs: env.engageWindowMinutes() * 60_000,
    // Phase 0 reads no history, so it cannot tell that humans took turns.
    humansAlternated: false,
    rootBand: { minLength: ROOT_MIN_LENGTH, debounceMs: ROOT_DEBOUNCE_MS },
  };
}

/**
 * Phase 0 shadow: run the ladder on a message the agent is not going to
 * answer, count what it would have done, and log one line. Counters only: no
 * adapter, no history read, and nothing here changes what the agent does.
 *
 * At level `mention` (the default) it returns before reading anything. It
 * never throws, and its one wait (the record read) is bounded.
 */
export async function observeEngage(i: ObserveInput): Promise<TierResult | null> {
  try {
    const channel: string = i.event?.channel;
    if (!channel) return null;
    const setting = engageFor(i.personaId, channel);
    if (setting.level === "mention") return null;
    const level = setting.level;
    const thread: string | null = i.event.thread_ts && i.event.thread_ts !== i.event.ts ? i.event.thread_ts : null;
    // The record is read and cleared by the first human message after the agent spoke.
    const rec = await readRecord(channel, thread);
    const restricted = channelTrustFor(channel, trustSoulFor(i.personaId)) === "unknown";
    const r = runTiers(factsFromEvent(i, level, restricted, rec));
    metric.engageTotal.inc({ tier: r.action === "existing" ? "existing" : String(r.tier), outcome: r.action, level });
    console.log(`[engage] phase0 channel=${channel} level=${level} tier=${r.action === "existing" ? "existing" : r.tier} would=${r.action} reason=${r.reason}`);
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
