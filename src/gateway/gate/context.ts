import { rankScore } from "../../knowledge/gather";
import type { GateInput, Trust } from "./types";

export interface GateContextDeps {
  /**
   * Returns the most recent `limit` messages of the thread up to and including
   * the event (oldest-first order is fine). Slack's conversations.replies is
   * oldest-first, so the real implementation must fetch the tail, not the head.
   */
  replies: (
    channel: string,
    threadTs: string,
    limit: number,
  ) => Promise<Array<{ user?: string; bot_id?: string; text?: string; ts: string }>>;
  /** null when the brain is off. */
  kbSearch: ((query: string) => Promise<Array<{ score?: number; rerank_score?: number }>>) | null;
  selfIds: { botUserId: string; botIds: Set<string> };
}

const MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

/** `<@BOT>` becomes `<agent>`, any other `<@U…>` / `<@W…>` (optionally `|name`) becomes `<user>`. */
export function resolveMentions(text: string, botUserId: string): string {
  return text.replace(MENTION_RE, (_m, id: string) => (id === botUserId ? "<agent>" : "<user>"));
}

/**
 * Reduces Slack markup before the text leaves the gateway: mentions to roles,
 * channels, groups, broadcasts, links and emails to generic tokens or labels.
 */
export function normalizeSlackText(text: string, botUserId: string): string {
  return resolveMentions(text, botUserId).replace(/<([^<>]+)>/g, (m, inner: string) => {
    if (inner.startsWith("#C")) return "<channel>";
    if (inner.startsWith("!subteam^")) return "<group>";
    if (/^!(here|channel|everyone)(\||$)/.test(inner)) return "<here>";
    if (inner.startsWith("!")) return inner.split("|")[1] ?? "";
    if (/^mailto:/i.test(inner)) return "<email>";
    if (/^https?:\/\//i.test(inner)) {
      const bar = inner.indexOf("|");
      if (bar >= 0) return inner.slice(bar + 1);
      try {
        return new URL(inner).host;
      } catch {
        return "<link>";
      }
    }
    return m;
  });
}

export async function buildGateInput(
  e: { channel: string; ts: string; thread_ts?: string; text: string },
  o: { mentionsAgent: boolean; engaged: boolean; channelTrust: Trust; contextMessages: number },
  d: GateContextDeps,
): Promise<GateInput> {
  const { botUserId, botIds } = d.selfIds;
  const isAgent = (m: { user?: string; bot_id?: string }) =>
    m.user === botUserId || (m.bot_id !== undefined && botIds.has(m.bot_id));

  let recent: GateInput["recent"] = [];
  if (e.thread_ts && e.thread_ts !== e.ts) {
    try {
      const msgs = await d.replies(e.channel, e.thread_ts, o.contextMessages + 1);
      recent = msgs
        .filter((m) => Number(m.ts) < Number(e.ts))
        .slice(-o.contextMessages)
        .map((m) => ({
          role: isAgent(m) ? ("agent" as const) : ("user" as const),
          text: normalizeSlackText(m.text ?? "", botUserId),
        }));
    } catch {
      recent = [];
    }
  }

  const message = normalizeSlackText(e.text, botUserId);

  let kbHitScore: number | null = null;
  if (d.kbSearch) {
    try {
      const hits = await d.kbSearch(message);
      const top = hits.reduce((best, h) => Math.max(best, rankScore(h)), 0);
      kbHitScore = Math.min(1, Math.max(0, top));
    } catch {
      kbHitScore = null;
    }
  }

  return {
    message,
    recent,
    mentionsAgent: o.mentionsAgent,
    engaged: o.engaged,
    kbHitScore,
    channelTrust: o.channelTrust,
  };
}
