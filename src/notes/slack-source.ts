import type { WebClientLike } from "../gateway/core/transport";
import type { SourceMessage } from "./summarize";

export interface LoadedThreadSource {
  messages: SourceMessage[];
  eligibleCount: number;
  truncated: boolean;
}

function tsValue(ts: string): bigint | null {
  const match = ts.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const fraction = (match[2] ?? "").slice(0, 6).padEnd(6, "0");
  return BigInt(match[1]!) * 1_000_000n + BigInt(fraction || "0");
}

function before(left: string, right: string): boolean {
  const a = tsValue(left);
  const b = tsValue(right);
  return a !== null && b !== null && a < b;
}

export async function loadThreadSource(
  client: WebClientLike,
  input: { channel: string; threadTs: string; beforeTs: string },
): Promise<LoadedThreadSource> {
  let eligibleCount = 0;
  let bounded: SourceMessage[] = [];
  let cursor: string | undefined;
  let remoteTruncated = false;
  const seenCursors = new Set<string>();
  const seenMessages = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const response = await client.conversations.replies({
      channel: input.channel,
      ts: input.threadTs,
      limit: 200,
      latest: input.beforeTs,
      inclusive: false,
      ...(cursor ? { cursor } : {}),
    });
    for (const message of Array.isArray(response.messages) ? response.messages : []) {
      if (typeof message?.ts !== "string" || !before(message.ts, input.beforeTs) || seenMessages.has(message.ts)) continue;
      seenMessages.add(message.ts);
      eligibleCount++;
      bounded.push({
        author: String(message.user ?? message.bot_id ?? "unknown"),
        text: String(message.text ?? ""),
        ref: String(message.ts),
      });
    }
    bounded.sort((a, b) => {
      const av = tsValue(a.ref)!;
      const bv = tsValue(b.ref)!;
      return av < bv ? -1 : av > bv ? 1 : 0;
    });
    if (bounded.length > 200) bounded = bounded.slice(-200);
    const next = String(response.response_metadata?.next_cursor ?? "").trim();
    if (!next) {
      remoteTruncated = Boolean(response.has_more);
      break;
    }
    if (seenCursors.has(next)) {
      remoteTruncated = true;
      break;
    }
    seenCursors.add(next);
    cursor = next;
    if (page === 19) remoteTruncated = true;
  }
  const selected: SourceMessage[] = [];
  let chars = 0;
  let localTruncated = false;
  for (let i = bounded.length - 1; i >= 0; i--) {
    const message = bounded[i]!;
    const overhead = message.author.length + message.ref.length;
    const available = 80_000 - chars - overhead;
    if (available <= 0) {
      localTruncated = true;
      break;
    }
    const text = message.text.length > available ? message.text.slice(-available) : message.text;
    if (text.length < message.text.length) localTruncated = true;
    selected.push({ ...message, text });
    chars += overhead + text.length;
    if (localTruncated) break;
  }
  selected.reverse();
  return {
    messages: selected,
    eligibleCount,
    truncated: remoteTruncated || localTruncated || eligibleCount > selected.length,
  };
}

export function validatePermalink(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || /[<>|\s]/.test(value)) {
    throw new Error("Slack returned an invalid decision-note permalink");
  }
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const slackHost = host === "slack.com" || host.endsWith(".slack.com")
    || host === "slack-gov.com" || host.endsWith(".slack-gov.com");
  if (url.protocol !== "https:" || !slackHost) {
    throw new Error("Slack returned a non-Slack HTTPS decision-note permalink");
  }
  return url.toString();
}
