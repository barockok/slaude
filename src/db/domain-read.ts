/**
 * Read models over the domain records for the console (read only). Lists page
 * newest first on `(created_at, id)`; values that identify a person outside
 * Slack (email, phone) are masked here, so no caller can forget to.
 */
import { db as globalDb, type DbClient } from "./schema";
import type {
  BindingView, BoundaryListItem, BoundaryPage, StateCounts, UserDetail, UserListItem, UserPage,
} from "../gateway/panel/api-types";
import type { BindingRow, BoundaryRow, State, UserRow } from "./domain";

/** A record that has only ever been declared and is older than this is "unmatched". */
export const UNMATCHED_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
export const DOMAIN_PAGE_DEFAULT = 50;
export const DOMAIN_PAGE_MAX = 200;

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** `a***@example.com`; a phone keeps its last two digits; anything else is shown as is. */
export function maskValue(service: string, kind: string, value: string): string {
  if (service === "email" || EMAIL_SHAPE.test(value)) {
    const at = value.lastIndexOf("@");
    if (at <= 0) return "***";
    return `${value.slice(0, 1)}***@${value.slice(at + 1)}`;
  }
  if (kind === "phone") return `***${value.slice(-2)}`;
  return value;
}

/**
 * For views of a merge or a proposal, where one of the records may belong to
 * another person: an address or phone as `maskValue`, any other identifier (a
 * Slack id, a sign-in subject) as its first and last two characters.
 */
export function maskIdentifier(service: string, kind: string, value: string): string {
  if (service === "email" || kind === "phone" || EMAIL_SHAPE.test(value)) return maskValue(service, kind, value);
  return value.length <= 5 ? "***" : `${value.slice(0, 2)}***${value.slice(-2)}`;
}

/** An operator or actor id for display: `system` as is, an address masked, anything else shortened. */
export function maskActor(actor: string | null): string | null {
  if (actor === null) return null;
  return actor === "system" ? actor : maskIdentifier("", "", actor);
}

export interface DomainFilter {
  state?: State;
  service?: string;
  /**
   * Prefix of a binding or boundary value. Never matches a user binding that is
   * masked in the answer (service email, kind phone, or a value shaped like an
   * address, such as an oidc subject): a prefix search would otherwise confirm
   * an address one character at a time.
   */
  q?: string;
}
export interface PageOpts {
  cursor?: string;
  limit?: number;
}

const h = (tx?: DbClient): DbClient => tx ?? globalDb;
const num = (v: unknown) => Number(v);
const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** `\`, `%` and `_` in a prefix are literal. */
const likePrefix = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`) + "%";

/** Cursor is `<created_at>:<id>`; an unreadable one is `null`. */
export function parseCursor(c: string | undefined): { at: number; id: string } | null | undefined {
  if (c === undefined) return undefined;
  const m = /^(\d{1,15}):([A-Za-z0-9-]{1,48})$/.exec(c);
  return m ? { at: Number(m[1]), id: m[2]! } : null;
}
export const validCursor = (c: string | undefined) => parseCursor(c) !== null;

export function clampLimit(limit: number | undefined): number {
  return Math.min(DOMAIN_PAGE_MAX, Math.max(1, limit ?? DOMAIN_PAGE_DEFAULT));
}

/**
 * The rule of `preferredBinding` in ./domain, over rows already read, plus a
 * last resort: a user with only declared or non-Slack bindings (an email not
 * yet verified) still shows its best binding rather than nothing.
 */
export function pickPreferred<T extends Pick<BindingRow, "service" | "state" | "created_at" | "id">>(rows: T[]): T | null {
  const rank = (s: string) => (s === "verified" ? 0 : s === "observed" ? 1 : 2);
  const byAge = (a: T, b: T) => Number(a.created_at) - Number(b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const mail = rows.filter((r) => r.service === "email" && r.state === "verified").sort(byAge)[0];
  if (mail) return mail;
  const byState = (a: T, b: T) => rank(a.state) - rank(b.state) || byAge(a, b);
  return rows.filter((r) => r.service === "slack").sort(byState)[0] ?? [...rows].sort(byState)[0] ?? null;
}

function label(b: Pick<BindingRow, "service" | "kind" | "value" | "workspace">): string {
  const v = maskValue(b.service, b.kind, b.value);
  return b.service === "email" ? v : `${b.service} ${b.kind} ${v}`;
}

const isUnmatched = (states: State[], createdAt: number, now: number) =>
  states.length > 0 && states.every((s) => s === "declared") && now - createdAt > UNMATCHED_AFTER_MS;

export async function listUsers(f: DomainFilter, o: PageOpts = {}, now: number = Date.now(), tx?: DbClient): Promise<UserPage> {
  const c = h(tx);
  const limit = clampLimit(o.limit);
  const where: string[] = [];
  const args: unknown[] = [];
  const inner: string[] = [];
  if (f.state) { inner.push("b.state = ?"); args.push(f.state); }
  if (f.service) { inner.push("b.service = ?"); args.push(f.service); }
  if (f.q) {
    inner.push("b.service <> 'email' AND b.kind <> 'phone' AND b.value NOT LIKE '%@%' AND (b.value LIKE ? ESCAPE '\\' OR b.value LIKE ? ESCAPE '\\')");
    args.push(likePrefix(f.q), likePrefix(f.q.toLowerCase()));
  }
  if (inner.length) where.push(`EXISTS (SELECT 1 FROM bindings b WHERE b.user_id = u.id AND ${inner.join(" AND ")})`);
  const cur = parseCursor(o.cursor);
  if (cur) { where.push("(u.created_at < ? OR (u.created_at = ? AND u.id < ?))"); args.push(cur.at, cur.at, cur.id); }
  const rows = await c.query<UserRow>(
    `SELECT u.* FROM users u ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY u.created_at DESC, u.id DESC LIMIT ?`,
    [...args, limit + 1],
  );
  const page = rows.slice(0, limit);
  const ids = page.map((u) => u.id);
  const bindings = ids.length
    ? await c.query<BindingRow>(`SELECT * FROM bindings WHERE user_id IN (${marks(ids.length)})`, ids)
    : [];
  const aliases = ids.length
    ? await c.query<{ user_id: string; n: number }>(
        `SELECT user_id, COUNT(*) AS n FROM user_aliases WHERE user_id IN (${marks(ids.length)}) GROUP BY user_id`,
        ids,
      )
    : [];
  const aliasN = new Map(aliases.map((a) => [a.user_id, num(a.n)]));
  const items = page.map((u): UserListItem => {
    const mine = bindings.filter((b) => b.user_id === u.id);
    const counts: StateCounts = { declared: 0, observed: 0, verified: 0 };
    for (const b of mine) counts[b.state]++;
    const pref = pickPreferred(mine);
    return {
      id: u.id,
      kind: u.kind,
      preferred: pref ? label(pref) : null,
      bindings: counts,
      aliasCount: aliasN.get(u.id) ?? 0,
      createdAt: num(u.created_at),
      unmatched: isUnmatched(mine.map((b) => b.state), num(u.created_at), now),
    };
  });
  const last = page[page.length - 1];
  return { items, nextCursor: rows.length > limit && last ? `${num(last.created_at)}:${last.id}` : null };
}

/** One user by id, or by the old id of a merged one. Null when neither exists. */
export async function getUserDetail(id: string, now: number = Date.now(), tx?: DbClient): Promise<UserDetail | null> {
  const c = h(tx);
  let user = await c.one<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
  if (!user) {
    const a = await c.one<{ user_id: string }>("SELECT user_id FROM user_aliases WHERE old_id = ?", [id]);
    if (a) user = await c.one<UserRow>("SELECT * FROM users WHERE id = ?", [a.user_id]);
  }
  if (!user) return null;
  const bindings = await c.query<BindingRow>("SELECT * FROM bindings WHERE user_id = ? ORDER BY created_at, id", [user.id]);
  const aliases = await c.query<{ old_id: string; merged_at: number }>(
    "SELECT old_id, merged_at FROM user_aliases WHERE user_id = ? ORDER BY merged_at, old_id",
    [user.id],
  );
  return {
    id: user.id,
    kind: user.kind,
    displayName: user.display_name,
    createdAt: num(user.created_at),
    unmatched: isUnmatched(bindings.map((b) => b.state), num(user.created_at), now),
    bindings: bindings.map((b) => ({
      id: b.id,
      service: b.service,
      kind: b.kind,
      workspace: b.workspace,
      value: maskValue(b.service, b.kind, b.value),
      state: b.state,
      source: b.source,
      createdAt: num(b.created_at),
      verifiedAt: b.verified_at == null ? null : num(b.verified_at),
    })),
    aliases: aliases.map((a) => ({ oldId: a.old_id, mergedAt: num(a.merged_at) })),
  };
}

export async function listBoundaries(f: DomainFilter, o: PageOpts = {}, now: number = Date.now(), tx?: DbClient): Promise<BoundaryPage> {
  const c = h(tx);
  const limit = clampLimit(o.limit);
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.state) { where.push("state = ?"); args.push(f.state); }
  if (f.service) { where.push("service = ?"); args.push(f.service); }
  if (f.q) {
    where.push("(value LIKE ? ESCAPE '\\' OR value LIKE ? ESCAPE '\\')");
    args.push(likePrefix(f.q), likePrefix(f.q.toLowerCase()));
  }
  const cur = parseCursor(o.cursor);
  if (cur) { where.push("(created_at < ? OR (created_at = ? AND id < ?))"); args.push(cur.at, cur.at, cur.id); }
  const rows = await c.query<BoundaryRow>(
    `SELECT * FROM boundaries ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`,
    [...args, limit + 1],
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((b) => ({
      id: b.id,
      kind: b.kind,
      service: b.service,
      workspace: b.workspace,
      value: maskValue(b.service, "", b.value),
      state: b.state,
      displayName: b.display_name,
      createdAt: num(b.created_at),
      unmatched: isUnmatched([b.state], num(b.created_at), now),
    })),
    nextCursor: rows.length > limit && last ? `${num(last.created_at)}:${last.id}` : null,
  };
}
