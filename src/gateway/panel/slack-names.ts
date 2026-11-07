/**
 * Slack channel and user names for the console, resolved on the gateway (the
 * browser never calls Slack). One cached lookup per id:
 *
 *  - a channel id → `#name` through `conversations.info`;
 *  - a DM → `DM with <name>` when its user resolves through `users.info`,
 *    else `DM`;
 *  - a user id → the person's display name.
 *
 * Each lookup goes through the Slack client of the persona (and app) the row
 * belongs to, since a channel is only visible to an app that is in it. A
 * failure, a timeout or a missing client answers null, so the caller shows the
 * id; failures are cached for a shorter time than names so a transient error
 * clears itself. Names never leave this process other than in API answers.
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
  /** How long a failed lookup is kept (ms). Default 5 minutes. */
  failTtlMs?: number;
  /** Longest wait for one Slack call (ms); a slower answer reads as unknown. Default 2 s. */
  timeoutMs?: number;
  /** Most entries kept; the oldest go first. Default 5000. */
  maxEntries?: number;
  now?: () => number;
}

interface Entry {
  value: string | null;
  exp: number;
}

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

export function createSlackNames(opts: SlackNamesOptions): SlackNames {
  const ttl = opts.ttlMs ?? 3_600_000;
  const failTtl = opts.failTtlMs ?? 300_000;
  const timeout = opts.timeoutMs ?? 2_000;
  const max = opts.maxEntries ?? 5_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, Entry>();
  const inflight = new Map<string, Promise<string | null>>();

  const withTimeout = <T>(p: Promise<T>): Promise<T | null> =>
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), timeout);
      p.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        () => {
          clearTimeout(t);
          resolve(null);
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

  /** One cached, de-duplicated lookup. */
  function cached(key: string, load: () => Promise<string | null>): Promise<string | null> {
    const hit = cache.get(key);
    if (hit && hit.exp > now()) return Promise.resolve(hit.value);
    const running = inflight.get(key);
    if (running) return running;
    const p = (async () => {
      let value: string | null = null;
      try {
        value = await load();
      } catch {
        value = null;
      }
      remember(key, value);
      return value;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  async function client(ctx: NameContext): Promise<SlackNameClient | null> {
    try {
      return await opts.clientFor(ctx);
    } catch {
      return null;
    }
  }

  function userName(userId: string, ctx: NameContext = {}): Promise<string | null> {
    if (!USER_RE.test(userId)) return Promise.resolve(null);
    return cached(`u:${userId}`, async () => {
      const c = await client(ctx);
      if (!c) return null;
      return userNameOf(await withTimeout(c.users.info({ user: userId })));
    });
  }

  function channelLabel(channelId: string, ctx: NameContext = {}): Promise<string | null> {
    if (!CHANNEL_RE.test(channelId)) return Promise.resolve(null);
    return cached(`c:${channelId}`, async () => {
      const c = await client(ctx);
      if (!c) return null;
      const ch = obj(obj(await withTimeout(c.conversations.info({ channel: channelId })))?.channel);
      if (!ch) return null;
      if (ch.is_im === true || channelId.startsWith("D")) {
        const other = str(ch.user);
        const name = other ? await userName(other, ctx) : null;
        return name ? `DM with ${name}` : "DM";
      }
      const name = str(ch.name);
      return name ? `#${name}` : null;
    });
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
  for (const it of items) if (it.channelId && !seen.has(it.channelId)) seen.set(it.channelId, it.ctx);
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
