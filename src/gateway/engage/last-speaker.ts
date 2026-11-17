/**
 * The last-speaker record: who spoke last in a conversation, when it was the
 * agent. It lets the deterministic tiers decide "this message follows the
 * agent's own answer" with no history call.
 *
 * Written where the gateway sees the agent's own message (its echo, and the
 * outbound choke point), read and cleared by the next human message in the
 * same place. The read and the clear are one atomic step (Redis GETDEL, a
 * Map delete in memory), so two replicas that both see a message after the
 * agent spoke cannot both treat it as the follower: one gets the record, the
 * other gets nothing. The record lives for the engage window.
 *
 * Redis is optional and best effort, as in src/guardrails/high-water.ts: with
 * none, this process's memory is the record; a Redis error reads as "no
 * record" and never reaches a caller.
 */
import type { Redis } from "ioredis";
import { env } from "../../config/env";

export interface LastSpeaker {
  /** Slack ts of the agent's message. */
  ts: string;
  /** The agent's persona name ("default" for the default one). */
  persona: string;
  /** The Slack app id it posted through ("" when unknown). */
  app: string;
  /** The person the agent answered (the turn's user), or null when it spoke unprompted. */
  repliedToUser: string | null;
}

/** Where a record lives: a channel, and a thread (null: the channel's top level). */
export interface SpeakerPlace {
  channel: string;
  thread: string | null;
}

export interface LastSpeakerStore {
  /**
   * Remember `rec` for the place, replacing any earlier one; with `ifAbsent`,
   * only when the place has none (the echo of a message must not overwrite
   * the richer record the outbound path wrote). Never throws.
   */
  put(place: SpeakerPlace, rec: LastSpeaker, o?: { ttlSeconds?: number; ifAbsent?: boolean }): Promise<void>;
  /** Return the place's record and remove it in one step; null when none. Never throws. */
  take(place: SpeakerPlace): Promise<LastSpeaker | null>;
}

const placeKey = (p: SpeakerPlace): string => `${p.channel}:${p.thread ?? "root"}`;
const defaultTtl = (): number => env.engageWindowMinutes() * 60;

function parse(raw: unknown): LastSpeaker | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Partial<LastSpeaker>;
    if (typeof v.ts !== "string" || typeof v.persona !== "string") return null;
    return { ts: v.ts, persona: v.persona, app: typeof v.app === "string" ? v.app : "", repliedToUser: typeof v.repliedToUser === "string" ? v.repliedToUser : null };
  } catch {
    return null;
  }
}

/** The in-process store (mono, and the fallback). */
export function memoryLastSpeakerStore(now: () => number = Date.now): LastSpeakerStore {
  const m = new Map<string, { rec: LastSpeaker; until: number }>();
  return {
    async put(place, rec, o = {}) {
      const t = now();
      if (m.size > 5000) for (const [k, v] of m) if (v.until <= t) m.delete(k);
      const k = placeKey(place);
      if (o.ifAbsent && (m.get(k)?.until ?? 0) > t) return;
      m.set(k, { rec, until: t + (o.ttlSeconds ?? defaultTtl()) * 1000 });
    },
    async take(place) {
      const k = placeKey(place);
      const v = m.get(k);
      m.delete(k);
      return v && v.until > now() ? v.rec : null;
    },
  };
}

/** The Redis commands the store uses (GETDEL needs Redis 6.2). */
export type SpeakerRedis = Pick<Redis, "set" | "getdel">;

/** A Redis-backed store shared by every replica. Errors read as "no record". */
export function redisLastSpeakerStore(client: SpeakerRedis, prefix = "slaude"): LastSpeakerStore {
  const key = (p: SpeakerPlace) => `${prefix}:engage:last:${placeKey(p)}`;
  return {
    async put(place, rec, o = {}) {
      try {
        const ttl = Math.max(1, Math.floor(o.ttlSeconds ?? defaultTtl()));
        if (o.ifAbsent) await client.set(key(place), JSON.stringify(rec), "EX", ttl, "NX");
        else await client.set(key(place), JSON.stringify(rec), "EX", ttl);
      } catch (e) {
        console.warn(`[engage] last-speaker write to Redis failed: ${(e as Error).message}`);
      }
    },
    async take(place) {
      try {
        return parse(await client.getdel(key(place)));
      } catch (e) {
        console.warn(`[engage] last-speaker read from Redis failed: ${(e as Error).message}`);
        return null;
      }
    },
  };
}

let current: LastSpeakerStore = memoryLastSpeakerStore();

/** The process-wide store. */
export function lastSpeakers(): LastSpeakerStore {
  return current;
}

/** Keep records in Redis when the deployment has one (the gateway calls this); null goes back to memory. */
export function setLastSpeakerRedis(client: SpeakerRedis | null, prefix = "slaude"): void {
  current = client ? redisLastSpeakerStore(client, prefix) : memoryLastSpeakerStore();
}

/** TEST SEAM: replace or reset the process-wide store. */
export function __setLastSpeakerStoreForTests(s: LastSpeakerStore | null): void {
  current = s ?? memoryLastSpeakerStore();
}
