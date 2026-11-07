/**
 * Slack channel and user names for the console, resolved on the gateway (the
 * browser never calls Slack). One cached lookup per id:
 *
 *  - a channel id → `#name` through `conversations.info`;
 *  - a DM → `DM with <name>` when its user resolves through `users.info`,
 *    else `DM`;
 *  - a user id → the person's display name.
 *
 * Each lookup asks the Slack client of the app (or persona) the row belongs
 * to, since a channel is only visible to an app that is in it. The gateway
 * hands this module dedicated lookup clients (no retries, rate limits
 * rejected), never the clients that post, so a lookup cannot stall a reply.
 *
 * Bounds, so a console page can never flood Slack or wait on it:
 *  - one overall deadline per label (client resolution and the DM's
 *    users.info included); past it the caller shows the id (or `DM`) and the
 *    lookup still in flight fills the cache for next time;
 *  - at most {@link MAX_CONCURRENT} Slack calls at once;
 *  - at most {@link MAX_PER_ANSWER} ids resolved per API answer;
 *  - a 429 pauses that client's lookups for the Retry-After period and is
 *    never cached as "not found".
 *
 * A resolved name is cached by id (any app sees the same name); a miss is
 * cached per app, so one app's `channel_not_found` does not hide a name
 * another app can read. Names never leave this process other than in API answers.
 */

/** The two Web API methods used here (a WebClient, or a stub in tests). */
export interface SlackNameClient {
  conversations: { info(args: { channel: string }): Promise<unknown> };
  users: { info(args: { user: string }): Promise<unknown> };
}

/** Whose client resolves a name: the persona, and the app when known. */
export interface NameContext {
  persona?: string | null;
  appId?: string | null;
  teamId?: string | null;
}

export interface SlackNames {
  /** `#name`, `DM with Jane Doe`, `DM`, or null when unknown. */
  channelLabel(channelId: string, ctx?: NameContext): Promise<string | null>;
  /** A person's display name, or null. */
  userName(userId: string, ctx?: NameContext): Promise<string | null>;
}

export interface SlackNamesOptions {
  /** The Slack client to ask, or null when there is none (no Slack, a persona not live). */
  clientFor: (ctx: NameContext) => SlackNameClient | null | Promise<SlackNameClient | null>;
  /** How long a resolved name is kept (ms). Default 1 hour. */
  ttlMs?: number;
  /** How long a miss is kept (ms). Default 5 minutes. */
  failTtlMs?: number;
  /** Overall deadline for one label or name (ms). Default 2 s. */
  deadlineMs?: number;
  /** Longest a lookup may run in the background after its deadline (ms). Default 15 s. */
  backgroundMs?: number;
  /** Most entries kept; the oldest go first. Default 5000. */
  maxEntries?: number;
  now?: () => number;
}

/** Slack calls in flight at once, across every lookup. */
export const MAX_CONCURRENT = 6;
/** Distinct ids resolved for one API answer; the rest show their ids. */
export const MAX_PER_ANSWER = 50;

interface Entry {
  value: string | null;
  exp: number;
}

/** What one load came to: a name, a miss worth remembering, or nothing to cache (rate limit, timeout). */
type Loaded = { value: string | null; cache: "hit" | "miss" | "none" };

const CHANNEL_RE = /^[CGD][A-Z0-9]{2,}$/;
const USER_RE = /^[UW][A-Z0-9]{2,}$/;

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The best name of a `users.info` answer: display name, then real name, then handle. */
export function userNameOf(res: unknown): string | null {
  const user = obj(obj(res)?.user);
  if (!user) return null;
  const profile = obj(user.profile);
  return str(profile?.display_name) ?? str(profile?.real_name) ?? str(user.real_name) ?? str(user.name);
}

/** Seconds to wait when `e` is a Slack rate limit (a rejected 429), else null. */
export function rateLimitSeconds(e: unknown): number | null {
  const o = obj(e);
  if (!o) return null;
  const limited = o.code === "slack_webapi_rate_limited_error" || o.statusCode === 429 || o.status === 429;
  if (!limited) return null;
  const n = Number(o.retryAfter ?? obj(o.headers)?.["retry-after"]);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

/** Thrown inside a load to say "do not cache": a rate limit or a paused client. */
class Transient extends Error {}

const appKey = (ctx: NameContext) => ctx.appId || (ctx.persona && ctx.persona !== "default" ? `persona:${ctx.persona}` : ctx.teamId ? `team:${ctx.teamId}` : "-");

export function createSlackNames(opts: SlackNamesOptions): SlackNames {
  const ttl = opts.ttlMs ?? 3_600_000;
  const failTtl = opts.failTtlMs ?? 300_000;
  const deadline = opts.deadlineMs ?? 2_000;
  const background = opts.backgroundMs ?? 15_000;
  const max = opts.maxEntries ?? 5_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, Entry>();
  const inflight = new Map<string, Promise<string | null>>();
  /** A rate-limited client's lookups resume at this time. */
  const pausedUntil = new WeakMap<object, number>();

  // At most MAX_CONCURRENT Slack calls at once; the rest queue.
  let running = 0;
  const queue: Array<() => void> = [];
  async function slot<T>(f: () => Promise<T>): Promise<T> {
    if (running >= MAX_CONCURRENT) await new Promise<void>((r) => queue.push(r));
    running++;
    try {
      return await f();
    } finally {
      running--;
      queue.shift()?.();
    }
  }

  /** `p`, or `fallback` once `ms` passed (p keeps running). */
  const within = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(fallback), ms);
      p.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        () => {
          clearTimeout(t);
          resolve(fallback);
        },
      );
    });

  function remember(key: string, value: string | null): void {
    if (cache.size >= max) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { value, exp: now() + (value === null ? failTtl : ttl) });
  }

  function fresh(key: string): Entry | undefined {
    const e = cache.get(key);
    return e && e.exp > now() ? e : undefined;
  }

  /**
   * One cached, de-duplicated lookup under the overall deadline. A name is
   * stored under `hitKey` (shared by every app), a miss under `missKey` (this
   * app only). Past the deadline the caller gets `onDeadline`; the load keeps
   * going (bounded by `background`) and fills the cache.
   */
  function cached(hitKey: string, missKey: string, onDeadline: string | null, load: () => Promise<Loaded>): Promise<string | null> {
    const hit = fresh(hitKey);
    if (hit) return Promise.resolve(hit.value);
    const miss = fresh(missKey);
    if (miss) return Promise.resolve(onDeadline);
    let p = inflight.get(missKey);
    if (!p) {
      p = within(load(), background, { value: null, cache: "none" } as Loaded)
        .then((r) => {
          if (r.cache === "hit" && r.value !== null) remember(hitKey, r.value);
          else if (r.cache === "miss") remember(missKey, null);
          return r.value;
        })
        .finally(() => inflight.delete(missKey));
      inflight.set(missKey, p);
    }
    return within(p, deadline, onDeadline).then((v) => v ?? onDeadline);
  }

  async function client(ctx: NameContext): Promise<SlackNameClient> {
    let c: SlackNameClient | null;
    try {
      c = await opts.clientFor(ctx);
    } catch {
      c = null;
    }
    if (!c) throw new Transient("no client");
    if ((pausedUntil.get(c) ?? 0) > now()) throw new Transient("rate limited");
    return c;
  }

  /** One Slack call through the limiter; a 429 pauses the client and is not cached. */
  async function call(c: SlackNameClient, f: () => Promise<unknown>): Promise<unknown> {
    try {
      return await slot(f);
    } catch (e) {
      const wait = rateLimitSeconds(e);
      if (wait !== null) {
        pausedUntil.set(c, now() + wait * 1000);
        throw new Transient("rate limited");
      }
      throw e;
    }
  }

  /** A load's outcome, with a transient failure kept out of the cache. */
  const settle = async (f: () => Promise<string | null | Loaded>): Promise<Loaded> => {
    try {
      const value = await f();
      if (value !== null && typeof value === "object") return value;
      return { value, cache: value === null ? "miss" : "hit" };
    } catch (e) {
      return { value: null, cache: e instanceof Transient ? "none" : "miss" };
    }
  };

  async function loadUser(userId: string, ctx: NameContext): Promise<string | null> {
    const c = await client(ctx);
    return userNameOf(await call(c, () => c.users.info({ user: userId })));
  }

  function userName(userId: string, ctx: NameContext = {}): Promise<string | null> {
    if (!USER_RE.test(userId)) return Promise.resolve(null);
    return cached(`u:${userId}`, `u:${appKey(ctx)}:${userId}`, null, () => settle(() => loadUser(userId, ctx)));
  }

  function channelLabel(channelId: string, ctx: NameContext = {}): Promise<string | null> {
    if (!CHANNEL_RE.test(channelId)) return Promise.resolve(null);
    const dm = channelId.startsWith("D");
    return cached(`c:${channelId}`, `c:${appKey(ctx)}:${channelId}`, dm ? "DM" : null, () =>
      settle(async () => {
        const c = await client(ctx);
        const ch = obj(obj(await call(c, () => c.conversations.info({ channel: channelId })))?.channel);
        if (!ch) return null;
        if (ch.is_im === true || dm) {
          // Its own cached lookup: a slow users.info leaves this label as "DM" for now.
          const other = str(ch.user);
          const name = other ? await userName(other, ctx) : null;
          // No name yet (a miss, a rate limit, its deadline): "DM" for now, retried after the miss TTL.
          return name ? `DM with ${name}` : ({ value: "DM", cache: "miss" } as Loaded);
        }
        const name = str(ch.name);
        return name ? `#${name}` : null;
      }),
    );
  }

  return { channelLabel, userName };
}

/** Labels for many channels at once (each cached); the map holds only resolved ids. */
export async function channelLabels(
  names: SlackNames | null | undefined,
  items: Array<{ channelId: string | null | undefined; ctx?: NameContext }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!names) return out;
  const seen = new Map<string, NameContext | undefined>();
  for (const it of items) {
    if (seen.size >= MAX_PER_ANSWER) break;
    if (it.channelId && !seen.has(it.channelId)) seen.set(it.channelId, it.ctx);
  }
  await Promise.all(
    [...seen].map(async ([id, ctx]) => {
      const label = await names.channelLabel(id, ctx).catch(() => null);
      if (label) out.set(id, label);
    }),
  );
  return out;
}

/** `<#C123>` and `<#C123|name>` in a mandate's text: `#name` when known, else `#C123`. */
export function plainChannelRefs(text: string, labels: ReadonlyMap<string, string>): string {
  return text.replace(/<#([A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, given?: string) => {
    const known = labels.get(id);
    if (known) return known;
    return given ? `#${given}` : `#${id}`;
  });
}

/** Most distinct mentions resolved for one answer (each is a cached Slack call). */
export const MAX_MENTIONS = 25;

/**
 * Display names for the `<@U…>` mentions in some texts, resolved through the
 * cache (at most {@link MAX_MENTIONS} distinct ids); undefined when nothing
 * resolved. The console renders a mention it has no name for as `@U…`.
 */
export async function mentionNames(
  names: SlackNames | null | undefined,
  items: Array<{ text: string }>,
  ctx?: NameContext,
): Promise<Record<string, string> | undefined> {
  if (!names) return undefined;
  const ids = new Set<string>();
  for (const it of items) {
    for (const m of it.text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)) {
      if (ids.size >= MAX_MENTIONS) break;
      ids.add(m[1]!);
    }
  }
  if (ids.size === 0) return undefined;
  const out: Record<string, string> = {};
  await Promise.all(
    [...ids].map(async (id) => {
      const n = await names.userName(id, ctx).catch(() => null);
      if (n) out[id] = n;
    }),
  );
  return Object.keys(out).length ? out : undefined;
}
