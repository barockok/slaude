/**
 * Shared state for the phase 1 shadow classifier: what keeps it cheap and
 * single. Every key is per channel (never per app delivery), so two apps or
 * two replicas in one channel spend one budget and make one call.
 *
 *  - claim: one app copy owns the call for a message (`SET NX` on channel and ts).
 *  - spend: a per-channel daily token bucket and a per-minute ceiling.
 *  - pass memory: after a classifier "no", later unmentioned messages in that
 *    thread pass until the agent speaks, a new author joins, the name is used
 *    or 30 minutes pass (`engage:pass:<channel>:<thread>`, EX 1800).
 *  - root cooldown: after a "no" on a root message, the next few candidates (or
 *    120 s) pass unless the name is used.
 *  - sample: a capped sample of tier 2 run decisions.
 *  - claimAct and actSlot (phase 2): one owner per message across personas and
 *    apps, and the channel's hourly cap of acted runs.
 *
 * Redis is optional, as in last-speaker.ts: with none the process's memory is
 * the state. A Redis failure fails CLOSED for the classifier (no claim, no
 * budget: a pass) and OPEN for observation (the memories read as empty).
 */
import type { Redis } from "ioredis";
import { env } from "../../config/env";

export type SpendResult = "ok" | "day" | "minute" | "error";

export interface EngageState {
  /**
   * True for exactly one caller per (channel, ts, persona): the persona's app
   * copies share one claim, two personas on one message each have their own.
   * A store error is false.
   */
  claim(channel: string, ts: string, persona: string): Promise<boolean>;
  /**
   * Take one call from the channel's minute ceiling and daily bucket (shared by
   * every persona and app of the channel, keyed with the tenant). A store error is "error".
   */
  spend(channel: string, tenant?: string): Promise<SpendResult>;
  /** Remember a classifier "no" for a persona in a thread, with the author it was about. */
  markPass(channel: string, thread: string, persona: string, author: string): Promise<void>;
  /** Whether the persona's pass memory for a thread covers this author. A new author is not covered. */
  passed(channel: string, thread: string, persona: string, author: string): Promise<boolean>;
  /** The persona spoke in the thread: forget its pass. */
  clearPass(channel: string, thread: string, persona: string): Promise<void>;
  /** Remember a persona's classifier "no" for a root message. */
  markCooldown(channel: string, persona: string): Promise<void>;
  /** Whether a root candidate is inside the persona's cooldown (counts it as one of the next K). */
  cooling(channel: string, persona: string): Promise<boolean>;
  /**
   * Phase 2 owner claim: true for exactly one caller per (channel, ts), whatever
   * the persona or the app. Taken only by a copy that has decided `run` and is
   * about to act. A store error is false (nobody acts).
   */
  claimAct(channel: string, ts: string): Promise<boolean>;
  /**
   * Phase 2 acting cap: take one of the channel's acted runs for this hour.
   * "cap" past `limit`, "error" on a store failure (both mean do not act).
   */
  actSlot(channel: string, limit: number, tenant?: string): Promise<"ok" | "cap" | "error">;
  /** One tier 2 sample: false unless the draw hits and the channel's daily sample cap has room. */
  sample(channel: string, tenant?: string): Promise<boolean>;
  /** Remember that two humans took turns in a thread (read by the ladder's next message). */
  markAlternated(channel: string, thread: string): Promise<void>;
  alternated(channel: string, thread: string): Promise<boolean>;
}

export const PASS_MEMORY_SECONDS = 1800;
export const COOLDOWN_SECONDS = 120;
export const COOLDOWN_CANDIDATES = 3;
export const SAMPLE_DAILY_CAP = 5;
const CLAIM_SECONDS = 120;
const ACT_CLAIM_SECONDS = 300;

export interface StateOpts {
  dailyBudget?: () => number;
  minuteCeiling?: () => number;
  /** 1 in N; 0 is off. */
  sampleEvery?: () => number;
  rng?: () => number;
  now?: () => number;
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const minute = (ms: number): number => Math.floor(ms / 60_000);
const hour = (ms: number): number => Math.floor(ms / 3_600_000);
const opts = (o: StateOpts) => ({
  daily: o.dailyBudget ?? (() => env.engageDailyBudget()),
  perMinute: o.minuteCeiling ?? (() => env.engageMinuteCeiling()),
  every: o.sampleEvery ?? (() => env.engageSample()),
  rng: o.rng ?? Math.random,
  now: o.now ?? Date.now,
});

/** The in-process state (mono, and the fallback). */
export function memoryEngageState(o: StateOpts = {}): EngageState {
  const c = opts(o);
  const counts = new Map<string, { n: number; until: number }>();
  const flags = new Map<string, { v: string; until: number }>();
  const sets = new Map<string, { v: Set<string>; until: number }>();
  const sweep = (t: number) => {
    if (counts.size + flags.size + sets.size < 5000) return;
    for (const [k, v] of counts) if (v.until <= t) counts.delete(k);
    for (const [k, v] of flags) if (v.until <= t) flags.delete(k);
    for (const [k, v] of sets) if (v.until <= t) sets.delete(k);
  };
  const incr = (k: string, ttlS: number): number => {
    const t = c.now();
    sweep(t);
    const cur = counts.get(k);
    const n = cur && cur.until > t ? cur.n + 1 : 1;
    counts.set(k, { n, until: cur && cur.until > t ? cur.until : t + ttlS * 1000 });
    return n;
  };
  const getFlag = (k: string): string | null => {
    const v = flags.get(k);
    return v && v.until > c.now() ? v.v : null;
  };
  const setFlag = (k: string, v: string, ttlS: number, nx = false): boolean => {
    if (nx && getFlag(k) !== null) return false;
    flags.set(k, { v, until: c.now() + ttlS * 1000 });
    return true;
  };
  return {
    async claim(channel, ts, persona) {
      return setFlag(`claim:${channel}:${ts}:${persona}`, "1", CLAIM_SECONDS, true);
    },
    async spend(channel, tenant = "-") {
      const t = c.now();
      if (incr(`rate:${tenant}:${channel}:${minute(t)}`, 120) > c.perMinute()) return "minute";
      if (incr(`day:${tenant}:${channel}:${day(t)}`, 172_800) > c.daily()) return "day";
      return "ok";
    },
    async markPass(channel, thread, persona, author) {
      const k = `pass:${channel}:${thread}:${persona}`;
      const t = c.now();
      const cur = sets.get(k);
      // The authors accumulate; the 30 minutes run from the first "no".
      if (cur && cur.until > t) cur.v.add(author);
      else sets.set(k, { v: new Set([author]), until: t + PASS_MEMORY_SECONDS * 1000 });
    },
    async passed(channel, thread, persona, author) {
      const cur = sets.get(`pass:${channel}:${thread}:${persona}`);
      return !!cur && cur.until > c.now() && cur.v.has(author);
    },
    async clearPass(channel, thread, persona) {
      sets.delete(`pass:${channel}:${thread}:${persona}`);
    },
    async markCooldown(channel, persona) {
      setFlag(`cool:${channel}:${persona}`, String(COOLDOWN_CANDIDATES), COOLDOWN_SECONDS);
    },
    async cooling(channel, persona) {
      const k = `cool:${channel}:${persona}`;
      const left = Number(getFlag(k));
      if (!(left > 0)) return false;
      if (left <= 1) flags.delete(k);
      else flags.set(k, { v: String(left - 1), until: flags.get(k)!.until });
      return true;
    },
    async claimAct(channel, ts) {
      return setFlag(`act:${channel}:${ts}`, "1", ACT_CLAIM_SECONDS, true);
    },
    async actSlot(channel, limit, tenant = "-") {
      return incr(`actcap:${tenant}:${channel}:${hour(c.now())}`, 7200) > limit ? "cap" : "ok";
    },
    async sample(channel, tenant = "-") {
      const n = c.every();
      if (n <= 0 || c.rng() >= 1 / n) return false;
      return incr(`sample:${tenant}:${channel}:${day(c.now())}`, 172_800) <= SAMPLE_DAILY_CAP;
    },
    async markAlternated(channel, thread) {
      setFlag(`alt:${channel}:${thread}`, "1", env.engageWindowMinutes() * 60);
    },
    async alternated(channel, thread) {
      return getFlag(`alt:${channel}:${thread}`) !== null;
    },
  };
}

/**
 * The Redis scripts the store runs, each one atomic. The test double
 * (tests/helpers/fake-engage-redis.ts) runs the same operations by identity.
 */
export const SCRIPTS = {
  /** KEYS[1] counter, ARGV[1] ttl seconds: INCR, and the expiry set with the first increment. */
  incrExpire: "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; return n",
  /** KEYS[1] a countdown: take one if any is left (the key goes away at zero, never to -1). Returns 1 when one was taken. */
  takeOne:
    "local v = tonumber(redis.call('GET', KEYS[1])); if not v or v <= 0 then return 0 end; if v <= 1 then redis.call('DEL', KEYS[1]) else redis.call('DECR', KEYS[1]) end; return 1",
  /** KEYS[1] a set, ARGV[1] member, ARGV[2] ttl: SADD, and the expiry set only when the set has none (the window runs from the first add). */
  addMember: "redis.call('SADD', KEYS[1], ARGV[1]); if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end; return 1",
} as const;

/** The Redis commands the store uses. */
export type EngageRedis = Pick<Redis, "set" | "get" | "del" | "eval" | "sismember">;

/** A Redis-backed state shared by every replica. Classifier-side errors fail closed, observation-side errors read as empty. */
export function redisEngageState(client: EngageRedis, prefix = "slaude", o: StateOpts = {}): EngageState {
  const c = opts(o);
  const k = (s: string) => `${prefix}:engage:${s}`;
  const warn = (what: string, e: unknown) => console.warn(`[engage] state ${what} failed: ${(e as Error).message}`);
  const incr = async (key: string, ttlS: number): Promise<number> => Number(await client.eval(SCRIPTS.incrExpire, 1, key, String(ttlS)));
  return {
    async claim(channel, ts, persona) {
      try {
        return (await client.set(k(`claim:${channel}:${ts}:${persona}`), "1", "EX", CLAIM_SECONDS, "NX")) === "OK";
      } catch (e) {
        warn("claim", e);
        return false;
      }
    },
    async spend(channel, tenant = "-") {
      try {
        const t = c.now();
        if ((await incr(k(`rate:${tenant}:${channel}:${minute(t)}`), 120)) > c.perMinute()) return "minute";
        if ((await incr(k(`day:${tenant}:${channel}:${day(t)}`), 172_800)) > c.daily()) return "day";
        return "ok";
      } catch (e) {
        warn("spend", e);
        return "error";
      }
    },
    async markPass(channel, thread, persona, author) {
      try {
        await client.eval(SCRIPTS.addMember, 1, k(`pass:${channel}:${thread}:${persona}`), author, String(PASS_MEMORY_SECONDS));
      } catch (e) {
        warn("pass write", e);
      }
    },
    async passed(channel, thread, persona, author) {
      try {
        return (await client.sismember(k(`pass:${channel}:${thread}:${persona}`), author)) === 1;
      } catch (e) {
        warn("pass read", e);
        return false;
      }
    },
    async clearPass(channel, thread, persona) {
      try {
        await client.del(k(`pass:${channel}:${thread}:${persona}`));
      } catch (e) {
        warn("pass clear", e);
      }
    },
    async markCooldown(channel, persona) {
      try {
        await client.set(k(`cool:${channel}:${persona}`), String(COOLDOWN_CANDIDATES), "EX", COOLDOWN_SECONDS);
      } catch (e) {
        warn("cooldown write", e);
      }
    },
    async cooling(channel, persona) {
      try {
        return Number(await client.eval(SCRIPTS.takeOne, 1, k(`cool:${channel}:${persona}`))) === 1;
      } catch (e) {
        warn("cooldown read", e);
        return false;
      }
    },
    async claimAct(channel, ts) {
      try {
        return (await client.set(k(`act:${channel}:${ts}`), "1", "EX", ACT_CLAIM_SECONDS, "NX")) === "OK";
      } catch (e) {
        warn("act claim", e);
        return false;
      }
    },
    async actSlot(channel, limit, tenant = "-") {
      try {
        return (await incr(k(`actcap:${tenant}:${channel}:${hour(c.now())}`), 7200)) > limit ? "cap" : "ok";
      } catch (e) {
        warn("act cap", e);
        return "error";
      }
    },
    async sample(channel, tenant = "-") {
      const n = c.every();
      if (n <= 0 || c.rng() >= 1 / n) return false;
      try {
        return (await incr(k(`sample:${tenant}:${channel}:${day(c.now())}`), 172_800)) <= SAMPLE_DAILY_CAP;
      } catch (e) {
        warn("sample", e);
        return false;
      }
    },
    async markAlternated(channel, thread) {
      try {
        await client.set(k(`alt:${channel}:${thread}`), "1", "EX", env.engageWindowMinutes() * 60);
      } catch (e) {
        warn("alternation write", e);
      }
    },
    async alternated(channel, thread) {
      try {
        return (await client.get(k(`alt:${channel}:${thread}`))) !== null;
      } catch {
        return false;
      }
    },
  };
}

let current: EngageState = memoryEngageState();

/** The process-wide state. */
export function engageState(): EngageState {
  return current;
}

/** Keep the state in Redis when the deployment has one (the gateway calls this); null goes back to memory. */
export function setEngageRedis(client: EngageRedis | null, prefix = "slaude"): void {
  current = client ? redisEngageState(client, prefix) : memoryEngageState();
}

/** TEST SEAM: replace or reset the process-wide state. */
export function __setEngageStateForTests(s: EngageState | null): void {
  current = s ?? memoryEngageState();
}

/**
 * What `allow()` hands back: the state the breaker was in when the call was
 * allowed. Its result counts only while that state still holds, so a late
 * failure from a call started before the breaker opened (or before a probe)
 * cannot extend the backoff or free the probe slot of a newer state.
 */
export interface BreakerTicket {
  readonly epoch: number;
  readonly probe: boolean;
}

/**
 * Three consecutive failures open the breaker; it stays open for a backoff
 * that doubles with each failed probe (30 s up to 10 min), then lets exactly
 * one half-open probe through. A success closes it. Per process.
 */
export interface CircuitBreaker {
  /** A ticket when a call may be made now (in the half-open state only the first caller gets one), else null. */
  allow(): BreakerTicket | null;
  success(t: BreakerTicket): void;
  failure(t: BreakerTicket): void;
  /** The allowed call made no request (budget, input): free a probe slot without judging the adapter. */
  release(t: BreakerTicket): void;
  readonly state: "closed" | "open" | "half-open";
}

export function circuitBreaker(o: { now?: () => number; threshold?: number; baseMs?: number; maxMs?: number } = {}): CircuitBreaker {
  const now = o.now ?? Date.now;
  const threshold = o.threshold ?? 3;
  const base = o.baseMs ?? 30_000;
  const max = o.maxMs ?? 600_000;
  let failures = 0;
  let open = false;
  let backoff = base;
  let until = 0;
  let probing = false;
  /** Bumped by every change of state (opened, probe started, probe failed, closed). */
  let epoch = 0;
  const stateNow = (): "closed" | "open" | "half-open" => (!open ? "closed" : now() >= until ? "half-open" : "open");
  return {
    get state() {
      return stateNow();
    },
    allow() {
      const s = stateNow();
      if (s === "closed") return { epoch, probe: false };
      if (s === "open" || probing) return null;
      probing = true;
      epoch++;
      return { epoch, probe: true };
    },
    release(t) {
      if (t.probe && t.epoch === epoch) probing = false;
    },
    success(t) {
      if (t.epoch !== epoch) return;
      failures = 0;
      open = false;
      backoff = base;
      probing = false;
      epoch++;
    },
    failure(t) {
      if (t.epoch !== epoch) return;
      if (t.probe) {
        // A failed probe: back off for twice as long.
        backoff = Math.min(backoff * 2, max);
        until = now() + backoff;
        probing = false;
        epoch++;
        return;
      }
      if (++failures >= threshold) {
        open = true;
        until = now() + backoff;
        probing = false;
        epoch++;
      }
    },
  };
}

let breaker = circuitBreaker();
export function engageBreaker(): CircuitBreaker {
  return breaker;
}
/** TEST SEAM. */
export function __setEngageBreakerForTests(b: CircuitBreaker | null): void {
  breaker = b ?? circuitBreaker();
}
