/**
 * Who in the workspace goes by a name, for tier 1's "Name, ..." rule: when a
 * colleague shares the agent's name, "Sam, can you look" may be for them, so
 * it goes to the classifier instead of running.
 *
 * One cached lookup per team (users.list, bounded pages and a deadline),
 * refreshed at most hourly and never on the message's own path: asking is a
 * synchronous read of the last snapshot, and a stale snapshot starts a
 * background refresh. The snapshot is workspace wide (a superset of one
 * channel's members), which only ever errs toward "someone shares the name".
 *
 * Unknown is the SAFE side: before the first load, and while every load has
 * failed, a name counts as shared, so tier 1's `name_comma` is not taken and
 * the message goes to tier 3. A failed refresh keeps the last good snapshot.
 */
import { foldAlias } from "../../persona/aliases";

export const USERS_TTL_MS = 3_600_000;
export const USERS_RETRY_MS = 300_000;
export const USERS_DEADLINE_MS = 3000;
const MAX_PAGES = 5;
const PAGE_SIZE = 200;

export interface UsersCache {
  /** Whether a human in the team goes by this folded name. Unknown reads as true. Never waits. */
  sameNamed(team: string | undefined, folded: string): boolean;
  /** Start a background refresh when the snapshot is missing or older than an hour. Never waits, never throws. */
  ensure(team: string | undefined, load: () => Promise<Set<string>>): void;
}

type Member = { deleted?: boolean; is_bot?: boolean; id?: string; name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } };

/** The folded names (and first names) of the people in a users.list page; bots and deactivated users are not people here. */
export function namesOf(members: Member[]): Set<string> {
  const out = new Set<string>();
  for (const m of members) {
    if (m.deleted || m.is_bot || m.id === "USLACKBOT") continue;
    for (const raw of [m.name, m.real_name, m.profile?.display_name, m.profile?.real_name]) {
      if (typeof raw !== "string" || !raw.trim()) continue;
      const full = foldAlias(raw);
      if (full) out.add(full);
      for (const part of raw.split(/[\s._-]+/)) {
        const f = part ? foldAlias(part) : "";
        if (f) out.add(f);
      }
    }
  }
  return out;
}

/** The loader the gateway gives `ensure`: users.list through a Slack client, bounded by pages and a deadline. */
export async function loadUserNames(
  client: { users: { list: (a: Record<string, unknown>) => Promise<any> } },
  deadlineMs = USERS_DEADLINE_MS,
): Promise<Set<string>> {
  const read = async (): Promise<Set<string>> => {
    const names = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await client.users.list({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
      if (!r?.ok) throw new Error("users.list failed");
      for (const n of namesOf(r.members ?? [])) names.add(n);
      cursor = r.response_metadata?.next_cursor || undefined;
      // A workspace past the page bound is a partial list: unknown names stay unknown, not "absent".
      if (!cursor) return names;
    }
    throw new Error("users.list longer than the page bound");
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const p = read();
  p.catch(() => {});
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("users.list deadline")), deadlineMs); })]);
  } finally {
    clearTimeout(timer);
  }
}

export function makeUsersCache(now: () => number = Date.now): UsersCache {
  const snaps = new Map<string, { names: Set<string>; at: number }>();
  const next = new Map<string, number>();
  const inflight = new Set<string>();
  const key = (t: string | undefined): string => t ?? "";
  return {
    sameNamed(team, folded) {
      const s = snaps.get(key(team));
      return s ? s.names.has(folded) : true;
    },
    ensure(team, load) {
      const k = key(team);
      const t = now();
      const s = snaps.get(k);
      if (inflight.has(k) || (s && t - s.at < USERS_TTL_MS) || (next.get(k) ?? 0) > t) return;
      inflight.add(k);
      void load()
        .then((names) => {
          snaps.set(k, { names, at: now() });
          next.delete(k);
        })
        .catch(() => {
          next.set(k, now() + USERS_RETRY_MS);
        })
        .finally(() => inflight.delete(k));
    },
  };
}

let current: UsersCache = makeUsersCache();
export function usersCache(): UsersCache {
  return current;
}
/** TEST SEAM. */
export function __setUsersCacheForTests(c: UsersCache | null): void {
  current = c ?? makeUsersCache();
}
