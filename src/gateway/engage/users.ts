/**
 * Who in the workspace goes by a name, for tier 1's "Name, ..." rule: when a
 * colleague shares the agent's name, "Sam, can you look" may be for them, so
 * it goes to the classifier instead of running.
 *
 * One cached lookup per team (users.list, up to 5 pages, a deadline on each page and on the whole read),
 * refreshed at most hourly and never on the message's own path: asking is a
 * synchronous read of the last snapshot, and a stale snapshot starts a
 * background refresh. The snapshot is workspace wide (a superset of one
 * channel's members), which only ever errs toward "someone shares the name".
 *
 * Unknown is the SAFE side: before the first load, and while every load has
 * failed, a name counts as shared, so tier 1's `name_comma` is not taken and
 * the message goes to tier 3. A failed refresh keeps the last good snapshot; a read that
 * stopped part way keeps what it read, and a name missing from it is unknown (shared).
 */
import { foldAlias } from "../../persona/aliases";

export const USERS_TTL_MS = 3_600_000;
export const USERS_RETRY_MS = 300_000;
/** One users.list page, and the whole read. */
export const USERS_PAGE_DEADLINE_MS = 2000;
export const USERS_TOTAL_DEADLINE_MS = 5000;
export const USERS_WARN_MS = 3_600_000;
const MAX_PAGES = 5;
const PAGE_SIZE = 200;

/** The names read, and whether the whole workspace was read. A name missing from an incomplete list is unknown, which reads as shared. */
export interface UsersSnapshot {
  names: Set<string>;
  complete: boolean;
}

export interface UsersCache {
  /** Whether a human in the team goes by this folded name. Unknown (no list, or a name missing from a partial one) reads as true. Never waits. */
  sameNamed(team: string | undefined, folded: string): boolean;
  /** Start a background refresh when the snapshot is missing or stale. Never waits, never throws. */
  ensure(team: string | undefined, load: () => Promise<UsersSnapshot>): void;
}

type Member = { deleted?: boolean; is_bot?: boolean; id?: string; name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } };

/**
 * The folded names (and first names) of the people in a users.list page. Bots
 * and deactivated users are not people here, and `exclude` (the agent's own
 * Slack user ids, so a persona that posts as a real user is not "a colleague
 * who shares its name") is left out.
 */
export function namesOf(members: Member[], exclude: ReadonlySet<string> = new Set()): Set<string> {
  const out = new Set<string>();
  for (const m of members) {
    if (m.deleted || m.is_bot || m.id === "USLACKBOT" || (m.id && exclude.has(m.id))) continue;
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

const within = <T>(p: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  p.catch(() => {});
  return Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error("deadline"), { code: "deadline" })), ms); })]).finally(() => clearTimeout(timer));
};

/** An error's code and nothing else: a Slack error name (`missing_scope`), a client code, or "error". */
export function errorCode(e: unknown): string {
  const x = e as { data?: { error?: unknown }; code?: unknown } | null;
  const c = x?.data?.error ?? x?.code;
  return typeof c === "string" && /^[\w.:-]{1,64}$/.test(c) ? c : "error";
}

/**
 * The loader the gateway gives `ensure`: users.list through a Slack client,
 * up to 5 pages with a deadline on each page and on the whole read. A page that
 * fails after the first keeps what was read (an incomplete snapshot); the
 * first page failing throws (the cache keeps its last list).
 */
export async function loadUserNames(
  client: { users: { list: (a: Record<string, unknown>) => Promise<any> } },
  o: { exclude?: ReadonlySet<string>; pageDeadlineMs?: number; totalDeadlineMs?: number } = {},
): Promise<UsersSnapshot> {
  const pageMs = o.pageDeadlineMs ?? USERS_PAGE_DEADLINE_MS;
  const t0 = Date.now();
  const total = o.totalDeadlineMs ?? USERS_TOTAL_DEADLINE_MS;
  const names = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const left = total - (Date.now() - t0);
    try {
      if (left <= 0) throw Object.assign(new Error("deadline"), { code: "deadline" });
      const r = await within(client.users.list({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) }), Math.min(pageMs, left));
      if (!r?.ok) throw Object.assign(new Error("users.list failed"), { code: typeof r?.error === "string" ? r.error : "error" });
      for (const n of namesOf(r.members ?? [], o.exclude)) names.add(n);
      cursor = r.response_metadata?.next_cursor || undefined;
    } catch (e) {
      if (page === 0) throw e;
      return { names, complete: false };
    }
    if (!cursor) return { names, complete: true };
  }
  return { names, complete: false };
}

export function makeUsersCache(now: () => number = Date.now, warn: (line: string) => void = (l) => console.warn(l)): UsersCache {
  const snaps = new Map<string, UsersSnapshot & { at: number }>();
  const next = new Map<string, number>();
  const warned = new Map<string, number>();
  const inflight = new Set<string>();
  const key = (t: string | undefined): string => t ?? "";
  return {
    sameNamed(team, folded) {
      const s = snaps.get(key(team));
      return s ? s.names.has(folded) || !s.complete : true;
    },
    ensure(team, load) {
      const k = key(team);
      const t = now();
      const s = snaps.get(k);
      const ttl = s && !s.complete ? USERS_RETRY_MS : USERS_TTL_MS;
      if (inflight.has(k) || (s && t - s.at < ttl) || (next.get(k) ?? 0) > t) return;
      inflight.add(k);
      void load()
        .then((snap) => {
          snaps.set(k, { ...snap, at: now() });
          next.delete(k);
        })
        .catch((e) => {
          next.set(k, now() + USERS_RETRY_MS);
          // One line per team per hour, with the error code only (a missing users:read scope reads as `missing_scope`).
          const last = warned.get(k);
          if (last === undefined || last + USERS_WARN_MS <= now()) {
            warned.set(k, now());
            try {
              warn(`[engage] users.list failed team=${k || "-"} code=${errorCode(e)}; names in this workspace read as shared until it loads`);
            } catch {
              /* a throwing logger changes nothing */
            }
          }
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
