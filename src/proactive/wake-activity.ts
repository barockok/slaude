/**
 * What happened since the agent last looked, read from Slack by code before a
 * wake's model call: its places' new messages, new replies in active threads,
 * and whether each of its recent posts got an answer. A wake is a fresh session,
 * so without this it cannot tell an approved item from an ignored one, and its
 * notes drift from what really happened. Bounded, and any read failure is stated
 * in the block rather than read as silence.
 */
import type { ProactivePost } from "../db/proactive-posts";
import { redactSecrets } from "../gateway/core/status-text";

export interface ActivityMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
}

/** Reads Slack as this agent. */
export interface ActivityReader {
  history(channel: string, oldestTs: string, limit: number): Promise<ActivityMessage[]>;
  replies(channel: string, threadTs: string, limit: number): Promise<ActivityMessage[]>;
}

const DAY_MS = 86_400_000;
const MAX_LOOKBACK_MS = 3 * DAY_MS;
const FIRST_LOOKBACK_MS = DAY_MS;
const MAX_MESSAGES = 30;
const MAX_THREADS = 5;
const MAX_REPLIES = 8;
const MSG_CHARS = 400;
const POST_CHARS = 160;
const POSTS_SHOWN = 8;
const MAX_CHARS = 7000;

const clean = (t: string | undefined, max: number): string => {
  const one = redactSecrets((t ?? "").replace(/\s+/g, " ").trim());
  return one.length > max ? `${one.slice(0, max)}...` : one;
};
const whenOf = (ts: string): string => new Date(Number(ts) * 1000).toISOString().slice(5, 16).replace("T", " ");
const slackErr = (e: unknown): string => (e as { data?: { error?: string } })?.data?.error ?? (e instanceof Error ? e.message : String(e));

function line(m: ActivityMessage, agentId: string): string {
  const who = m.user === agentId ? "you" : m.user ? `<@${m.user}>` : "a bot";
  return `- ${whenOf(m.ts)} ${who}: ${clean(m.text, MSG_CHARS)}`;
}

export async function recentActivity(a: {
  reader: ActivityReader;
  channels: readonly string[];
  posts: readonly ProactivePost[];
  agentId: string;
  lastWakeAt: number | null;
  now: Date;
}): Promise<string> {
  const now = a.now.getTime();
  const sinceMs = Math.max(a.lastWakeAt ?? now - FIRST_LOOKBACK_MS, now - MAX_LOOKBACK_MS);
  const oldest = (sinceMs / 1000).toFixed(6);
  const out: string[] = [];
  const ownPost = new Set(a.posts.map((p) => p.messageTs).filter(Boolean));

  for (const channel of a.channels) {
    let messages: ActivityMessage[];
    try {
      messages = await a.reader.history(channel, oldest, MAX_MESSAGES);
    } catch (e) {
      out.push(`<#${channel}>: could not be read (${slackErr(e)}). You are blind here: tell your manager once.`);
      continue;
    }
    // Slack returns newest first. Your own posts are listed below with their answers.
    const shown = messages.filter((m) => !ownPost.has(m.ts)).reverse();
    const lines = shown.map((m) => line(m, a.agentId));
    const active = messages
      .filter((m) => !ownPost.has(m.ts) && (m.reply_count ?? 0) > 0 && Number(m.latest_reply ?? 0) * 1000 >= sinceMs)
      .slice(0, MAX_THREADS);
    for (const root of active) {
      try {
        const replies = (await a.reader.replies(channel, root.ts, MAX_REPLIES + 1)).filter((r) => r.ts !== root.ts && Number(r.ts) * 1000 >= sinceMs);
        lines.push(`  In the thread of ${whenOf(root.ts)} ("${clean(root.text, 60)}", ts ${root.ts}):`, ...replies.map((r) => `  ${line(r, a.agentId)}`));
      } catch {
        // The top level still shows; a lost thread is not worth failing the rest.
      }
    }
    out.push(`<#${channel}> since ${new Date(sinceMs).toISOString().slice(0, 16)}Z:`, ...(lines.length ? lines : ["- (nothing new)"]));
  }

  const posts = a.posts.filter((p) => p.messageTs).slice(0, POSTS_SHOWN);
  if (posts.length) out.push("Your recent posts, newest first, and what came back:");
  for (const p of posts) {
    const head = `- ${new Date(p.postedAt).toISOString().slice(5, 16).replace("T", " ")} in ${p.channelId} (ts ${p.messageTs}): "${clean(p.text ?? p.topic, POST_CHARS)}"`;
    try {
      const replies = (await a.reader.replies(p.channelId, p.messageTs!, MAX_REPLIES + 1)).filter((r) => r.ts !== p.messageTs);
      if (!replies.length) {
        const hours = Math.floor((now - p.postedAt) / 3_600_000);
        out.push(`${head} NO ANSWER after ${hours}h`);
      } else {
        out.push(head, ...replies.slice(-MAX_REPLIES).map((r) => `  ${line(r, a.agentId)}`));
      }
    } catch (e) {
      out.push(`${head} (its replies could not be read: ${slackErr(e)})`);
    }
  }

  const text = out.join("\n");
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n(cut: use read_channel for the rest)` : text || "(nothing new)";
}
