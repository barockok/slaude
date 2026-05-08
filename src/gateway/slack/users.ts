import type { WebClient } from "@slack/web-api";

/** Best-effort username lookup with a small in-memory TTL cache. */
const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { name: string; at: number }>();

export async function resolveUserName(client: WebClient, userId: string): Promise<string> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.name;
  try {
    const r = await client.users.info({ user: userId });
    const u = r.user as any;
    const name =
      u?.profile?.display_name_normalized ||
      u?.profile?.real_name_normalized ||
      u?.real_name ||
      u?.name ||
      userId;
    cache.set(userId, { name, at: Date.now() });
    return name;
  } catch {
    return userId;
  }
}
