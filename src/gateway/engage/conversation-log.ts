/**
 * The conversation log: the last messages of a conversation as the gateway itself saw them, so the
 * engagement classifier's context never needs a read of the surface (one read per candidate message
 * is slow, rate limited and specific to one surface).
 *
 * It is fed from the stream the session sees: every message heard in a channel whose engage level
 * is not `mention`, and the agent's own posts (see record.ts). It is not the session transcript
 * (that lives with the worker node, does not exist for a thread with no session yet, and does not
 * hold the message being judged). A conversation is a channel's top level or one thread; its key is
 * surface neutral (`logKey`). A capped list per key: the newest `LOG_CAP` entries, kept `LOG_TTL_SECONDS`.
 *
 * Redis is optional and best effort, as in last-speaker.ts: with none, this process's memory is the
 * log; a Redis error or a slow Redis reads as "no entries" and never reaches a caller. An empty log
 * means the classifier sees the message alone (right after a channel is switched on, for one).
 * Text is stored cut to `LOG_TEXT_CHARS` and secrets are masked before it is stored (and again when the classifier
 * input is built); a message deleted or edited at the source is forgotten (`forget`).
 */
import type { Redis } from "ioredis";
import type { ThreadMsg } from "../core/thread-head";

/** Entries kept per conversation. */
export const LOG_CAP = 30;
/** Seconds an entry list is kept after its last append. */
export const LOG_TTL_SECONDS = 24 * 3600;
/** Characters of one entry's text. */
export const LOG_TEXT_CHARS = 1000;
/** Every log operation gives up after this long (a slow Redis reads as an empty log, a lost append). */
export const LOG_BUDGET_MS = 100;
/** The bot id the reader gives a message written by an agent of this gateway (`isAgent` in the classifier input). */
export const AGENT_BOT_ID = "agent";
/** The bot id the reader gives any other bot's message that has no id of its own. */
export const OTHER_BOT_ID = "bot";

export interface LogEntry {
  /** The surface's id of the message (a Slack ts). The idempotency key. */
  ref: string;
  /** The surface user or bot id of the author ("" when unknown). */
  author: string;
  isBot: boolean;
  text: string;
  /** The thread the message is in; absent for a top-level message. */
  threadRef?: string;
  /** Set when an agent of this gateway wrote it: the persona name ("default" for the default persona). */
  agent?: string;
}

export interface ConversationLog {
  /** Add an entry; a second entry with a `ref` already in the conversation is ignored. Never throws. */
  append(key: string, entry: LogEntry): Promise<void>;
  /** The conversation's newest `limit` entries, oldest first. Never throws; [] when unknown. */
  recent(key: string, limit: number): Promise<LogEntry[]>;
  /** Remove the entry with this `ref` (a message deleted or edited at the source). Never throws. */
  forget(key: string, ref: string): Promise<void>;
}

/** `<surface>:<channel>` for a channel's top level, `<surface>:<channel>:<thread>` for a thread. */
export const logKey = (surface: string, channel: string, thread?: string | null): string =>
  thread ? `${surface}:${channel}:${thread}` : `${surface}:${channel}`;

const clean = (e: LogEntry): LogEntry => {
  const text = e.text.length > LOG_TEXT_CHARS ? e.text.slice(0, LOG_TEXT_CHARS).replace(/[\ud800-\udbff]$/, "") : e.text;
  return { ...e, text };
};

function parse(raw: unknown): LogEntry | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw.slice(raw.indexOf("|") + 1)) as Partial<LogEntry>;
    if (typeof v.ref !== "string" || typeof v.text !== "string") return null;
    return {
      ref: v.ref,
      author: typeof v.author === "string" ? v.author : "",
      isBot: v.isBot === true,
      text: v.text,
      ...(typeof v.threadRef === "string" ? { threadRef: v.threadRef } : {}),
      ...(typeof v.agent === "string" ? { agent: v.agent } : {}),
    };
  } catch {
    return null;
  }
}

function bounded<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p.catch(() => fallback), new Promise<T>((r) => { timer = setTimeout(() => r(fallback), ms); timer.unref?.(); })]).finally(() => clearTimeout(timer));
}

/** The in-process log (mono, and the fallback). */
export function memoryConversationLog(now: () => number = Date.now): ConversationLog {
  const m = new Map<string, { entries: LogEntry[]; until: number }>();
  return {
    async append(key, entry) {
      const t = now();
      if (m.size > 5000) for (const [k, v] of m) if (v.until <= t) m.delete(k);
      const cur = m.get(key);
      const entries = cur && cur.until > t ? cur.entries : [];
      if (entries.some((x) => x.ref === entry.ref)) return;
      entries.push(clean(entry));
      if (entries.length > LOG_CAP) entries.splice(0, entries.length - LOG_CAP);
      m.set(key, { entries, until: t + LOG_TTL_SECONDS * 1000 });
    },
    async recent(key, limit) {
      const v = m.get(key);
      if (!v || v.until <= now()) return [];
      return v.entries.slice(-Math.max(0, limit)).map((e) => ({ ...e }));
    },
    async forget(key, ref) {
      const v = m.get(key);
      if (v) v.entries = v.entries.filter((x) => x.ref !== ref);
    },
  };
}

/** The Redis scripts the log runs. The test double (tests/helpers/fake-engage-redis.ts) runs the same operation by identity. */
export const LOG_SCRIPTS = {
  /** KEYS[1] list; ARGV: ref, item (`<ref>|<json>`), cap, ttl. Pushes unless an item with this ref is there; trims; sets the expiry. */
  append:
    "local items = redis.call('LRANGE', KEYS[1], 0, -1); local p = ARGV[1] .. '|'; " +
    "for _, v in ipairs(items) do if string.sub(v, 1, #p) == p then return 0 end end; " +
    "redis.call('RPUSH', KEYS[1], ARGV[2]); redis.call('LTRIM', KEYS[1], -tonumber(ARGV[3]), -1); redis.call('EXPIRE', KEYS[1], ARGV[4]); return 1",
  /** KEYS[1] list; ARGV: ref. Removes every item with this ref (items are `<ref>|<json>`). */
  forget:
    "local items = redis.call('LRANGE', KEYS[1], 0, -1); local p = ARGV[1] .. '|'; local n = 0; " +
    "for _, v in ipairs(items) do if string.sub(v, 1, #p) == p then n = n + redis.call('LREM', KEYS[1], 0, v) end end; return n",
} as const;

/** The Redis commands the log uses. */
export type LogRedis = Pick<Redis, "eval" | "lrange">;

/** A Redis-backed log shared by every replica. Errors and slow calls read as "no entries" and "nothing appended". */
export function redisConversationLog(client: LogRedis, prefix = "slaude", o: { budgetMs?: number } = {}): ConversationLog {
  const budget = o.budgetMs ?? LOG_BUDGET_MS;
  const k = (key: string) => `${prefix}:engage:log:${key}`;
  return {
    async append(key, entry) {
      try {
        const e = clean(entry);
        await bounded(client.eval(LOG_SCRIPTS.append, 1, k(key), e.ref, `${e.ref}|${JSON.stringify(e)}`, String(LOG_CAP), String(LOG_TTL_SECONDS)), budget, null);
      } catch (err) {
        console.warn(`[engage] conversation log write to Redis failed: ${(err as Error).message}`);
      }
    },
    async recent(key, limit) {
      try {
        const raw = await bounded(client.lrange(k(key), -Math.max(1, limit), -1), budget, [] as string[]);
        return raw.map(parse).filter((e): e is LogEntry => !!e);
      } catch (err) {
        console.warn(`[engage] conversation log read from Redis failed: ${(err as Error).message}`);
        return [];
      }
    },
    async forget(key, ref) {
      try {
        await bounded(client.eval(LOG_SCRIPTS.forget, 1, k(key), ref), budget, null);
      } catch (err) {
        console.warn(`[engage] conversation log forget in Redis failed: ${(err as Error).message}`);
      }
    },
  };
}

let current: ConversationLog = memoryConversationLog();

/** The process-wide log. */
export function conversationLog(): ConversationLog {
  return current;
}

/** Keep the log in Redis when the deployment has one (the gateway calls this); null goes back to memory. */
export function setConversationLogRedis(client: LogRedis | null, prefix = "slaude"): void {
  current = client ? redisConversationLog(client, prefix) : memoryConversationLog();
}

/** TEST SEAM: replace or reset the process-wide log. */
export function __setConversationLogForTests(l: ConversationLog | null): void {
  current = l ?? memoryConversationLog();
}

/**
 * A log entry as the classifier input's reader shape (`ThreadMsg`), so its filter, ownership and
 * agent checks stay as they are. `own` is the persona whose copy is asking: its own posts carry its
 * user id; another agent of this gateway is marked `AGENT_BOT_ID` (with its user id when `userOf` knows it);
 * any other bot is a bot message.
 */
export function toThreadMsg(e: LogEntry, own: { persona: string; userId: string }, userOf: (persona: string) => string | undefined): ThreadMsg {
  const base = { ts: e.ref, text: e.text, ...(e.threadRef ? { thread_ts: e.threadRef } : {}) };
  if (e.agent !== undefined) {
    const user = e.agent === own.persona ? own.userId : userOf(e.agent) ?? e.author;
    return { ...base, ...(user ? { user } : {}), bot_id: AGENT_BOT_ID, subtype: "bot_message" };
  }
  if (e.isBot) return { ...base, bot_id: e.author || OTHER_BOT_ID, subtype: "bot_message" };
  return { ...base, ...(e.author ? { user: e.author } : {}) };
}
