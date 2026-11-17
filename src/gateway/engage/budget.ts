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
 *
 * Redis is optional, as in last-speaker.ts: with none the process's memory is
 * the state. A Redis failure fails CLOSED for the classifier (no claim, no
 * budget: a pass) and OPEN for observation (the memories read as empty).
 */
import type { Redis } from "ioredis";
import { env } from "../../config/env";

export type SpendResult = "ok" | "day" | "minute" | "error";

export interface EngageState {
  /** True for exactly one caller per (channel, ts). A store error is false. */
  claim(channel: string, ts: string): Promise<boolean>;
  /** Take one call from the channel's minute ceiling and daily bucket. A store error is "error". */
  spend(channel: string): Promise<SpendResult>;
  /** Remember a classifier "no" for a thread, with the author it was about. */
  markPass(channel: string, thread: string, author: string): Promise<void>;
  /** Whether a thread's pass memory covers this author. A new author is not covered. */
  passed(channel: string, thread: string, author: string): Promise<boolean>;
  /** The agent spoke in the thread: forget the pass. */
  clearPass(channel: string, thread: string): Promise<void>;
  /** Remember a classifier "no" for a root message. */
  markCooldown(channel: string): Promise<void>;
  /** Whether a root candidate is inside the cooldown (counts it as one of the next K). */
  cooling(channel: string): Promise<boolean>;
  /** One tier 2 sample: false unless the draw hits and the channel's daily sample cap has room. */
  sample(channel: string): Promise<boolean>;
  /** Remember that two humans took turns in a thread (read by the ladder's next message). */
  markAlternated(channel: string, thread: string): Promise<void>;
  alternated(channel: string, thread: string): Promise<boolean>;
}

export const PASS_MEMORY_SECONDS = 1800;
export const COOLDOWN_SECONDS = 120;
export const COOLDOWN_CANDIDATES = 3;
export const SAMPLE_DAILY_CAP = 5;
const CLAIM_SECONDS = 120;

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
  const sweep = (t: number) => {
    if (counts.size + flags.size < 5000) return;
    for (const [k, v] of counts) if (v.until <= t) counts.delete(k);
    for (const [k, v] of flags) if (v.until <= t) flags.delete(k);
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
    async claim(channel, ts) {
      return setFlag(`claim:${channel}:${ts}`, "1", CLAIM_SECONDS, true);
    },
    async spend(channel) {
      const t = c.now();
      if (incr(`rate:${channel}:${minute(t)}`, 120) > c.perMinute()) return "minute";
      if (incr(`day:${channel}:${day(t)}`, 172_800) > c.daily()) return "day";
      return "ok";
    },
    async markPass(channel, thread, author) {
      const k = `pass:${channel}:${thread}`;
      const have = (getFlag(k) ?? "").split(",").filter(Boolean);
      const t = c.now();
      const until = flags.get(k)?.until;
      const set = new Set([...have, author]);
      flags.set(k, { v: [...set].join(","), until: until && until > t ? until : t + PASS_MEMORY_SECONDS * 1000 });
    },
    async passed(channel, thread, author) {
      return (getFlag(`pass:${channel}:${thread}`) ?? "").split(",").includes(author);
    },
    async clearPass(channel, thread) {
      flags.delete(`pass:${channel}:${thread}`);
    },
    async markCooldown(channel) {
      setFlag(`cool:${channel}`, String(COOLDOWN_CANDIDATES), COOLDOWN_SECONDS);
    },
    async cooling(channel) {
      const k = `cool:${channel}`;
      const left = Number(getFlag(k));
      if (!(left > 0)) return false;
      if (left <= 1) flags.delete(k);
      else flags.set(k, { v: String(left - 1), until: flags.get(k)!.until });
      return true;
    },
    async sample(channel) {
      const n = c.every();
      if (n <= 0 || c.rng() >= 1 / n) return false;
      return incr(`sample:${channel}:${day(c.now())}`, 172_800) <= SAMPLE_DAILY_CAP;
    },
    async markAlternated(channel, thread) {
      setFlag(`alt:${channel}:${thread}`, "1", env.engageWindowMinutes() * 60);
    },
    async alternated(channel, thread) {
      return getFlag(`alt:${channel}:${thread}`) !== null;
    },
  };
}

/** The Redis commands the store uses. */
export type EngageRedis = Pick<Redis, "set" | "get" | "del" | "incr" | "expire" | "decr">;

/** A Redis-backed state shared by every replica. Classifier-side errors fail closed, observation-side errors read as empty. */
export function redisEngageState(client: EngageRedis, prefix = "slaude", o: StateOpts = {}): EngageState {
  const c = opts(o);
  const k = (s: string) => `${prefix}:engage:${s}`;
  const warn = (what: string, e: unknown) => console.warn(`[engage] state ${what} failed: ${(e as Error).message}`);
  async function incr(key: string, ttlS: number): Promise<number> {
    const n = await client.incr(key);
    if (n === 1) await client.expire(key, ttlS);
    return n;
  }
  return {
    async claim(channel, ts) {
      try {
        return (await client.set(k(`claim:${channel}:${ts}`), "1", "EX", CLAIM_SECONDS, "NX")) === "OK";
      } catch (e) {
        warn("claim", e);
        return false;
      }
    },
    async spend(channel) {
      try {
        const t = c.now();
        if ((await incr(k(`rate:${channel}:${minute(t)}`), 120)) > c.perMinute()) return "minute";
        if ((await incr(k(`day:${channel}:${day(t)}`), 172_800)) > c.daily()) return "day";
        return "ok";
      } catch (e) {
        warn("spend", e);
        return "error";
      }
    },
    async markPass(channel, thread, author) {
      try {
        const key = k(`pass:${channel}:${thread}`);
        const have = ((await client.get(key)) ?? "").split(",").filter(Boolean);
        await client.set(key, [...new Set([...have, author])].join(","), "EX", PASS_MEMORY_SECONDS);
      } catch (e) {
        warn("pass write", e);
      }
    },
    async passed(channel, thread, author) {
      try {
        return ((await client.get(k(`pass:${channel}:${thread}`))) ?? "").split(",").includes(author);
      } catch (e) {
        warn("pass read", e);
        return false;
      }
    },
    async clearPass(channel, thread) {
      try {
        await client.del(k(`pass:${channel}:${thread}`));
      } catch (e) {
        warn("pass clear", e);
      }
    },
    async markCooldown(channel) {
      try {
        await client.set(k(`cool:${channel}`), String(COOLDOWN_CANDIDATES), "EX", COOLDOWN_SECONDS);
      } catch (e) {
        warn("cooldown write", e);
      }
    },
    async cooling(channel) {
      try {
        const key = k(`cool:${channel}`);
        const left = Number(await client.get(key));
        if (!(left > 0)) return false;
        if (left <= 1) await client.del(key);
        else await client.decr(key);
        return true;
      } catch (e) {
        warn("cooldown read", e);
        return false;
      }
    },
    async sample(channel) {
      const n = c.every();
      if (n <= 0 || c.rng() >= 1 / n) return false;
      try {
        return (await incr(k(`sample:${channel}:${day(c.now())}`), 172_800)) <= SAMPLE_DAILY_CAP;
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
 * Three consecutive failures open the breaker; it stays open for a backoff
 * that doubles with each failed probe (30 s up to 10 min), then lets exactly
 * one half-open probe through. A success closes it. Per process.
 */
export interface CircuitBreaker {
  /** Whether a call may be made now. In the half-open state only the first caller gets true until it reports. */
  allow(): boolean;
  success(): void;
  failure(): void;
  readonly state: "closed" | "open" | "half-open";
}

export function circuitBreaker(o: { now?: () => number; threshold?: number; baseMs?: number; maxMs?: number } = {}): CircuitBreaker {
  const now = o.now ?? Date.now;
  const threshold = o.threshold ?? 3;
  const base = o.baseMs ?? 30_000;
  const max = o.maxMs ?? 600_000;
  let failures = 0;
  let opened = 0;
  let backoff = base;
  let until = 0;
  let probing = false;
  const stateNow = (): "closed" | "open" | "half-open" => (opened === 0 ? "closed" : now() >= until ? "half-open" : "open");
  return {
    get state() {
      return stateNow();
    },
    allow() {
      const s = stateNow();
      if (s === "closed") return true;
      if (s === "open" || probing) return false;
      probing = true;
      return true;
    },
    success() {
      failures = 0;
      opened = 0;
      backoff = base;
      probing = false;
    },
    failure() {
      if (opened > 0) {
        // A failed probe: back off for twice as long.
        backoff = Math.min(backoff * 2, max);
        opened = now();
        until = opened + backoff;
        probing = false;
        return;
      }
      if (++failures >= threshold) {
        opened = now() || 1;
        until = opened + backoff;
        probing = false;
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
