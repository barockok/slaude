import type { DecisionNoteScope } from "../db/decision-notes";
import * as DecisionNotes from "../db/decision-notes";
import type { WebClientLike } from "../gateway/core/transport";

const membershipCache = new Map<string, { allowed: boolean; expiresAt: number }>();

async function isConversationMember(
  client: WebClientLike,
  input: { teamId: string; channelId: string; userId: string },
): Promise<boolean> {
  const key = `${input.teamId}:${input.channelId}:${input.userId}`;
  const cached = membershipCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.allowed;
  let cursor: string | undefined;
  const seen = new Set<string>();
  try {
    for (let page = 0; page < 100; page++) {
      const response = await client.conversations.members({
        channel: input.channelId,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      if ((response.members ?? []).includes(input.userId)) {
        membershipCache.set(key, { allowed: true, expiresAt: Date.now() + 60_000 });
        return true;
      }
      const next = String(response.response_metadata?.next_cursor ?? "").trim();
      if (!next || seen.has(next)) break;
      seen.add(next);
      cursor = next;
    }
  } catch {}
  membershipCache.set(key, { allowed: false, expiresAt: Date.now() + 15_000 });
  return false;
}

export async function visibleSourceChannels(input: {
  scope: DecisionNoteScope;
  currentChannelId: string;
  currentChannelType: string;
  userId: string;
  client: WebClientLike;
}): Promise<string[]> {
  if (input.currentChannelType !== "im") return [input.currentChannelId];
  const channels = DecisionNotes.listSourceChannels(input.scope);
  const visible = new Set<string>([input.currentChannelId]);
  for (const channelId of channels) {
    if (visible.has(channelId)) continue;
    if (await isConversationMember(input.client, {
      teamId: input.scope.slackTeamId,
      channelId,
      userId: input.userId,
    })) visible.add(channelId);
  }
  return [...visible];
}

export function clearVisibilityCacheForTests(): void {
  membershipCache.clear();
}
