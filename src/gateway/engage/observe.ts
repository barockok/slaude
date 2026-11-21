import { env } from "../../config/env";
import { m as metric } from "../../metrics";
import { channelTrustFor } from "../../knowledge/scope";
import { getPersonaRegistry } from "../../persona/registry";
import { foldAlias } from "../../persona/aliases";
import { trustSoulFor } from "../../soul/per-persona";
import { lastSpeakers, type LastSpeaker } from "./last-speaker";
import { engageFor } from "./setting";
import { plan, runCandidate, scheduleShadow, type ShadowDeps } from "./shadow";
import { MAX_TEXT, runTiers, type TierFacts, type TierResult } from "./tiers";

/** The reads of the last-speaker record may not hold the handler longer than this; a slow Redis reads as no record. */
export const RECORD_READ_BUDGET_MS = 100;
/** At most this many other personas are looked at for "another agent spoke last". */
const MAX_PEEKS = 8;

/**
 * Reasons that settle a message before the record matters (the safety rules).
 * A message settled by one of them never reads or clears the record: a bot
 * post, a join or a message to a colleague is not the follower of the agent's answer.
 */
const SETTLED_WITHOUT_RECORD: ReadonlySet<string> = new Set([
  "restricted", "subtype", "self_author", "lock_1on1", "lock_mention_only", "lock_disengaged",
  "names_other_person", "names_group", "names_other_agent",
]);

/** A decision to take part, handed to the caller's `act` (phase 2, mode on). */
export interface ImplicitRun {
  tier: 1 | 3;
  level: "addressed" | "contribute";
  /** Where the yes came from: the deterministic rules, or the classifier's confident answer. */
  source: "rules" | "classifier";
  reason: string;
  /** The ingress checks (blocked, ignored, locks, commands) already ran for this message, as part of the classifier job. */
  admitted: boolean;
}

/** Phase 2: what acts on a run decision. Absent (or the channel in shadow): nothing acts. */
export interface ActHooks {
  /**
   * Take part in the message (admission, owner claim, cap, then the mention path). Never
   * throws. Counts and logs its own outcome.
   */
  run(d: ImplicitRun): Promise<void>;
}

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
  /** Phase 1: what the shadow classifier needs. Absent: phase 0 only (counters and the one line). */
  shadow?: ShadowDeps;
  /** Phase 2: acts on a run decision when the channel's mode is `on`. */
  act?: ActHooks;
  /** Where the observation was made, for the log line. */
  site: "drop" | "channel_session";
}

const timeout = <T>(ms: number, v: T): Promise<T> => new Promise((r) => setTimeout(() => r(v), ms).unref?.());

async function readRecords(channel: string, thread: string | null, own: string, others: string[], consume = true): Promise<{ own: LastSpeaker | null; other: LastSpeaker | null }> {
  const none = { own: null, other: null };
  try {
    const store = lastSpeakers();
    const read = Promise.all([
      // A bot or agent post is not the follower of this agent's answer: it reads the record and leaves it for a person's follow-up.
      consume ? store.take({ channel, thread, persona: own }) : store.peek({ channel, thread, persona: own }),
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
  const raw = String(e.text ?? "");
  if (raw.length > MAX_TEXT) metric.engageTruncatedTotal.inc();
  return {
    text: raw.length > MAX_TEXT ? raw.slice(0, MAX_TEXT) : raw,
    subtype: e.subtype ?? null,
    authorIsBot: Boolean(e.bot_id || e.bot_profile),
    authorId: typeof e.user === "string" ? e.user : null,
    selfUserIds: self,
    threadEngaged: i.threadEngaged,
    level,
    restricted,
    locks: i.locks,
    lastSpeaker: own,
    otherSpeaker: other,
    agent: { name: me },
    otherAgents: others,
    nowMs: Date.now(),
    windowMs: env.engageWindowMinutes() * 60_000,
  };
}

/** Reasons of a classifier job that are an error, not a "no" (the rest of the non-answers are counted as the classifier's pass). */
const ERROR_REASONS: ReadonlySet<string> = new Set(["timeout", "error"]);

/**
 * Phase 2: the channel's mode is on and the ladder said run or classify. A run acts at once; a
 * classify is awaited (the deadline is the caller's, and it fails closed: anything but a confident
 * run is a counted pass, which is today's drop).
 */
async function actOn(i: ObserveInput, r: TierResult, level: "addressed" | "contribute", channel: string): Promise<void> {
  const act = i.act!;
  const count = (outcome: string) => metric.engageActTotal.inc({ tier: String(r.tier), outcome, level });
  if (r.action === "run") {
    await act.run({ tier: r.tier as 1 | 3, level, source: "rules", reason: r.reason, admitted: false });
    return;
  }
  const deps = i.shadow;
  if (!deps) {
    // No classifier wiring at all: a candidate nobody can judge is a pass.
    count("classifier_pass");
    return;
  }
  const thread = i.event.thread_ts && i.event.thread_ts !== i.event.ts ? String(i.event.thread_ts) : null;
  const cand = { channel, ts: String(i.event.ts), thread, level, persona: i.personaId, app: i.appId, result: r };
  const run: ImplicitRun = { tier: 3, level, source: "classifier", reason: r.reason, admitted: true };
  const guard = (deps.deadlineMs ?? 15_000) * 2 + 1_000;
  const out = await Promise.race([
    runCandidate(cand, { ...deps, acting: true }).catch(() => "error" as const),
    timeout(guard, "error" as const),
  ]);
  if (out === null) return; // another copy of this persona owns the call
  if (out === "error") {
    count("error");
    return;
  }
  if (out.action === "run" && out.reason === "answer") {
    await act.run(run);
    return;
  }
  count(ERROR_REASONS.has(out.reason) ? "error" : "classifier_pass");
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
      const rec = await readRecords(channel, thread, me, others, !(i.event.bot_id || i.event.bot_profile));
      if (rec.own || rec.other) r = runTiers(factsFromEvent(i, level, restricted, rec.own, rec.other));
    }
    const tier = r.action === "existing" ? "existing" : String(r.tier);
    metric.engageTotal.inc({ tier, outcome: r.action, level });
    // Phase 2: a channel whose mode is on acts on a run decision. The kill switch is read now, every time.
    if (setting.mode === "on" && i.act && (r.action === "run" || r.action === "classify")) {
      const actTier = r.tier as 1 | 3;
      if (env.engageForceShadow()) {
        metric.engageActTotal.inc({ tier: String(actTier), outcome: "forced_shadow", level });
      } else {
        console.log(`[engage] phase0 channel=${channel} level=${level} tier=${tier} would=${r.action} reason=${r.reason} classifier=${r.action === "run" ? "none" : "awaited"} mode=on`);
        await actOn(i, r, level, channel);
        return r;
      }
    }
    const p = plan(r, i.shadow);
    console.log(`[engage] phase0 channel=${channel} level=${level} tier=${tier} would=${r.action} reason=${r.reason} classifier=${"skip" in p ? `skip:${p.skip}` : "queued"}`);
    if (!("skip" in p) && i.shadow) {
      // After the handler has what it needs: the job runs on its own, with its own deadline.
      scheduleShadow(
        {
          channel,
          ts: String(i.event.ts),
          thread: i.event.thread_ts && i.event.thread_ts !== i.event.ts ? String(i.event.thread_ts) : null,
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
