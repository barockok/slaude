/**
 * Redis pub/sub channels (abort / reload / gate) + the per-session capped
 * event stream (spec §4).
 *
 * Channels are fire-and-forget wake-ups — all durable state lives in
 * Postgres/Redis elsewhere, so a missed publish only costs latency (the
 * subscriber's long-poll or TTL catches up). One shared subscriber connection
 * multiplexes all channels; per-channel callback sets are demuxed locally.
 */
import type { Redis } from "ioredis";
import { makeKeys, type Keys } from "./keys";

export interface StreamEvent {
  id: string;
  event: unknown;
}

export interface PubSubOpts {
  /** Command connection: PUBLISH / XADD / XRANGE. */
  redis: Redis;
  /** Dedicated subscriber connection (a subscribing conn can't run commands). */
  sub: Redis;
  keys?: Keys;
  /** Event stream cap (XADD MAXLEN ~). Spec default: 1000. */
  streamMaxLen?: number;
}

export type PubSub = ReturnType<typeof makePubSub>;

export function makePubSub(opts: PubSubOpts) {
  const { redis, sub } = opts;
  const keys = opts.keys ?? makeKeys();
  const maxLen = opts.streamMaxLen ?? 1000;
  const handlers = new Map<string, Set<(payload: string) => void>>();
  let listening = false;

  const ensureListener = () => {
    if (listening) return;
    listening = true;
    sub.on("message", (channel: string, payload: string) => {
      const set = handlers.get(channel);
      if (!set) return;
      for (const cb of [...set]) cb(payload);
    });
  };

  const on = async (channel: string, cb: (payload: string) => void): Promise<() => Promise<void>> => {
    ensureListener();
    let set = handlers.get(channel);
    if (!set) {
      set = new Set();
      handlers.set(channel, set);
      await sub.subscribe(channel);
    }
    set.add(cb);
    return async () => {
      const cur = handlers.get(channel);
      if (!cur) return;
      cur.delete(cb);
      if (cur.size === 0) {
        handlers.delete(channel);
        await sub.unsubscribe(channel).catch(() => {});
      }
    };
  };

  return {
    keys,

    /** Gateway → the node running the session: kill the in-flight turn. */
    async publishAbort(sessionId: string): Promise<number> {
      return await redis.publish(keys.abortChannel(sessionId), "1");
    },
    /** Node-side: fires when an abort for this session is published.
     *  Returns an unsubscribe fn. */
    onAbort(sessionId: string, cb: () => void) {
      return on(keys.abortChannel(sessionId), () => cb());
    },

    /** Gateway → nodes: tenant config changed, bust the runtime-bundle cache. */
    async publishReload(tenantId: string): Promise<number> {
      return await redis.publish(keys.reloadChannel(tenantId), "1");
    },
    onReload(tenantId: string, cb: () => void) {
      return on(keys.reloadChannel(tenantId), () => cb());
    },

    /** Any gateway replica → the long-polling node: gate resolved. */
    async publishGate(pendingId: string): Promise<number> {
      return await redis.publish(keys.gateChannel(pendingId), "1");
    },
    onGate(pendingId: string, cb: () => void) {
      return on(keys.gateChannel(pendingId), () => cb());
    },

    /** Node → gateway: append a serialized AgentEvent to the session's capped
     *  stream. Approximate trim (~) unless exact is requested. Returns the
     *  stream entry id. */
    async appendEvent(sessionId: string, event: unknown, o?: { exact?: boolean }): Promise<string> {
      const stream = keys.eventsStream(sessionId);
      const body = JSON.stringify(event);
      const id = o?.exact
        ? await redis.xadd(stream, "MAXLEN", maxLen, "*", "event", body)
        : await redis.xadd(stream, "MAXLEN", "~", maxLen, "*", "event", body);
      // XADD without NOMKSTREAM always returns the new entry id.
      return id!;
    },

    /** Read events after `fromId` (exclusive), oldest first; omit for all. */
    async readEvents(sessionId: string, fromId?: string): Promise<StreamEvent[]> {
      const rows = await redis.xrange(keys.eventsStream(sessionId), fromId ? `(${fromId}` : "-", "+");
      return rows.map(([id, fields]) => {
        const i = fields.indexOf("event");
        const raw = i >= 0 ? fields[i + 1]! : "null";
        let event: unknown;
        try {
          event = JSON.parse(raw);
        } catch {
          event = raw;
        }
        return { id, event };
      });
    },

    /** Drop every subscription this instance registered. */
    async close(): Promise<void> {
      const channels = [...handlers.keys()];
      handlers.clear();
      if (channels.length > 0) await sub.unsubscribe(...channels).catch(() => {});
    },
  };
}
