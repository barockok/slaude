import { rankScore } from "../../knowledge/gather";
import type { GateInput, Trust } from "./types";

export interface GateContextDeps {
  replies: (
    channel: string,
    threadTs: string,
    limit: number,
  ) => Promise<Array<{ user?: string; bot_id?: string; text?: string; ts: string }>>;
  /** null when the brain is off. */
  kbSearch: ((query: string) => Promise<Array<{ score?: number; rerank_score?: number }>>) | null;
  selfIds: { botUserId: string; botIds: Set<string> };
}

/** `<@BOT>` becomes `<agent>`, any other `<@U…>` (optionally `<@U…|name>`) becomes `<user>`. */
export function resolveMentions(text: string, botUserId: string): string {
  return text.replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_m, id: string) =>
    id === botUserId ? "<agent>" : "<user>",
  );
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
        .filter((m) => m.ts !== e.ts)
        .slice(-o.contextMessages)
        .map((m) => ({
          role: isAgent(m) ? ("agent" as const) : ("user" as const),
          text: resolveMentions(m.text ?? "", botUserId),
        }));
    } catch {
      recent = [];
    }
  }

  let kbHitScore: number | null = null;
  if (d.kbSearch) {
    try {
      const hits = await d.kbSearch(e.text);
      const top = hits.reduce((best, h) => Math.max(best, rankScore(h)), 0);
      kbHitScore = Math.min(1, Math.max(0, top));
    } catch {
      kbHitScore = null;
    }
  }

  return {
    message: resolveMentions(e.text, botUserId),
    recent,
    mentionsAgent: o.mentionsAgent,
    engaged: o.engaged,
    kbHitScore,
    channelTrust: o.channelTrust,
  };
}
