import { engageFor } from "./setting";
import { lastSpeakers, type SpeakerPlace } from "./last-speaker";
import { conversationLog, logKey, type LogEntry } from "./conversation-log";
import { redactSecrets } from "../core/status-text";

/** The surface id the conversation log keys use. */
const SURFACE = "slack";
/** Message kinds that are conversation (a join, a topic change or an edit is not). */
const CONVERSATION_SUBTYPES: ReadonlySet<string | undefined> = new Set([undefined, "file_share", "bot_message", "me_message", "thread_broadcast"]);

/** A Slack message ts. */
const TS = /^\d+\.\d+$/;

export interface AgentMessage {
  channel: string;
  /** The thread it was posted in; null for a top-level post. */
  thread: string | null;
  ts: string;
  /** The persona name; absent for the default persona. */
  persona?: string | null;
  app?: string | null;
  /** The person the agent answered, when the post is a reply to a turn. */
  repliedToUser?: string | null;
  /** The record comes from the agent's echo, which knows less than the outbound path. */
  fromEcho?: boolean;
  /** What it said, for the conversation log. */
  text?: string;
  /** The surface user id it posted as, when known (the echo knows it). */
  author?: string | null;
  /** The persona whose copy is looking (its level decides whether the log is written); default: the speaker. */
  viewer?: string | null;
  /** Every persona the delivery speaks for; see ConversationNote. */
  viewers?: ReadonlyArray<string | null | undefined>;
}

/** A message heard in a conversation (a person's, a bot's or an agent's), for the conversation log. */
export interface ConversationNote {
  channel: string;
  /** The thread it is in; null for a top-level message. */
  thread: string | null;
  ts: string;
  text: string;
  author?: string | null;
  isBot: boolean;
  /** The Slack message subtype; a kind that is not conversation is skipped. */
  subtype?: string | null;
  /** Set when an agent of this gateway wrote it: its persona name (null: the default persona). */
  agent?: { persona: string | null };
  /** The persona whose copy hears it; its level decides whether anything is written. */
  viewer?: string | null;
  /** Every persona this delivery speaks for (a shared app serves several): written when any one of them is above `mention`. Overrides `viewer`. */
  viewers?: ReadonlyArray<string | null | undefined>;
}

/** The log keys a message is stored under: its thread, or (top level) the channel and its own thread. */
function conversationKeys(channel: string, thread: string | null, ts: string): string[] {
  return thread ? [logKey(SURFACE, channel, thread)] : [logKey(SURFACE, channel), logKey(SURFACE, channel, ts)];
}

/**
 * A message deleted or edited at the source: drop it from the log (an edit is then heard again as a new
 * message). Written whatever the channel's level (an entry may predate a change of level) and never throws.
 * Resolves when the removal has been attempted.
 */
export async function forgetConversationMessage(m: { channel: string; thread: string | null; ts: string }): Promise<void> {
  try {
    if (!m.channel || !TS.test(m.ts)) return;
    await Promise.all(conversationKeys(m.channel, m.thread, m.ts).map((k) => Promise.resolve(conversationLog().forget(k, m.ts)).catch(() => {})));
  } catch {
    /* observing must never fail a message */
  }
}

/**
 * Add a heard message to the conversation log the engagement classifier reads. Observe only: a
 * channel at level `mention` (for the persona that heard it) writes nothing, an entry that is
 * already there (a message and its app_mention, an agent's post and its echo) is ignored, and
 * nothing here waits on or fails the caller. A top-level message is also the head of its own
 * thread (the replies under it find their root there).
 */
export function noteConversation(n: ConversationNote): void {
  try {
    if (!n.channel || !TS.test(n.ts) || !CONVERSATION_SUBTYPES.has(n.subtype ?? undefined)) return;
    const raw = (n.text ?? "").toString();
    if (!raw.trim()) return;
    // Secrets are masked before anything is stored: the log outlives the message in Redis.
    const text = redactSecrets(raw);
    const viewers = n.viewers ?? [n.viewer];
    if (!viewers.some((v) => engageFor(v && v !== "default" ? v : undefined, n.channel).level !== "mention")) return;
    const entry: LogEntry = {
      ref: n.ts,
      author: n.author ?? "",
      isBot: n.isBot,
      text,
      ...(n.thread ? { threadRef: n.thread } : {}),
      ...(n.agent ? { agent: n.agent.persona && n.agent.persona !== "default" ? n.agent.persona : "default" } : {}),
    };
    const keys = conversationKeys(n.channel, n.thread, n.ts);
    for (const k of keys) void Promise.resolve(conversationLog().append(k, entry)).catch(() => {});
  } catch {
    /* observing must never fail a message */
  }
}

/**
 * Remember that the agent just spoke, for the next human message there to
 * find. Observe only: with the channel at `mention` (the default) it does
 * nothing at all, and it never throws or waits on the caller's path.
 *
 * The record is per persona (two agents in a channel keep their own). A
 * top-level post is recorded under its own ts (the place its replies land)
 * and under the channel's top level; a post in a thread, under the thread.
 */
export function noteAgentMessage(m: AgentMessage): void {
  try {
    if (!m.channel || !TS.test(m.ts)) return;
    const persona = m.persona && m.persona !== "default" ? m.persona : undefined;
    noteConversation({ channel: m.channel, thread: m.thread, ts: m.ts, text: m.text ?? "", author: m.author, isBot: true, agent: { persona: persona ?? null }, viewer: m.viewer ?? persona, ...(m.viewers ? { viewers: m.viewers } : {}) });
    if (engageFor(persona, m.channel).level === "mention") return;
    const rec = { ts: m.ts, persona: persona ?? "default", app: m.app ?? "", repliedToUser: m.repliedToUser ?? null };
    const who = persona ?? "default";
    const places: SpeakerPlace[] = m.thread
      ? [{ channel: m.channel, thread: m.thread, persona: who }]
      : [{ channel: m.channel, thread: m.ts, persona: who }, { channel: m.channel, thread: null, persona: who }];
    for (const place of places) void lastSpeakers().put(place, rec, m.fromEcho ? { ifAbsent: true } : {}).catch(() => {});
  } catch {
    /* observing must never fail a post */
  }
}

/**
 * A human message that is handled some other way (an @mention, a reply in a
 * thread the agent is engaged in) is a message after the agent's: the record
 * is stale, so drop it. A cheap delete, and nothing at all at level `mention`.
 */
export function clearAgentRecord(m: { channel: string; thread: string | null; persona?: string | null }): void {
  try {
    const persona = m.persona && m.persona !== "default" ? m.persona : undefined;
    if (!m.channel || engageFor(persona, m.channel).level === "mention") return;
    void lastSpeakers().clear({ channel: m.channel, thread: m.thread, persona: persona ?? "default" }).catch(() => {});
  } catch {
    /* observing must never fail a message */
  }
}
