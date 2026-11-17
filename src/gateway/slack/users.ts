import type { WebClient } from "@slack/web-api";

/** Best-effort username lookup with a small in-memory TTL cache. */
const TTL_MS = 10 * 60 * 1000;
/** A failed lookup (the user id is shown instead) is remembered this long, so a failing cache is not asked again per message. */
const FAILED_TTL_MS = 60 * 1000;
const cache = new Map<string, { name: string; until: number }>();

export async function resolveUserName(client: WebClient, userId: string): Promise<string> {
  const hit = cache.get(userId);
  if (hit && Date.now() < hit.until) return hit.name;
  try {
    const r = await client.users.info({ user: userId });
    const u = r.user as any;
    const name =
      u?.profile?.display_name_normalized ||
      u?.profile?.real_name_normalized ||
      u?.real_name ||
      u?.name ||
      userId;
    cache.set(userId, { name, until: Date.now() + TTL_MS });
    return name;
  } catch {
    cache.set(userId, { name: userId, until: Date.now() + FAILED_TTL_MS });
    return userId;
  }
}

/** Test seam: forget every cached name. */
export function __resetUserNameCache(): void {
  cache.clear();
}
