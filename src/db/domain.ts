/**
 * Domain records (migration 0038): users, their bindings, boundaries and the
 * alias rows a merge leaves behind.
 *
 * Every function takes an optional `tx` (the handle `db.transaction` passes
 * its callback) and falls back to the global `db`. Multi-statement functions
 * open their own transaction when none is given, and join the caller's when
 * one is.
 *
 * Nothing here emits audit events: a function returns the events it caused
 * (`events`), and the caller writes them after its transaction commits through
 * `src/audit/domain.ts`. A batch caller skips that and writes one summary.
 *
 * A state only goes up: declared < observed < verified.
 */
import { randomUUID } from "node:crypto";
import { db as globalDb, type DbClient } from "./schema";

export type State = "declared" | "observed" | "verified";
export type UserKind = "person" | "bot" | "agent";

export interface UserRow {
  id: string;
  kind: UserKind;
  display_name: string | null;
  created_at: number;
  updated_at: number;
}

export interface BindingRow {
  id: string;
  user_id: string;
  service: string;
  kind: string;
  workspace: string;
  value: string;
  state: State;
  source: string;
  created_at: number;
  updated_at: number;
  verified_at: number | null;
}

export interface BoundaryRow {
  id: string;
  kind: string;
  display_name: string | null;
  service: string;
  workspace: string;
  value: string;
  state: State;
  created_at: number;
  updated_at: number;
}

/** What a write did, for `src/audit/domain.ts`. Ids and service names only, never a binding value. */
export type DomainEvent =
  | { action: "user.created"; userId: string }
  | { action: "binding.created"; userId: string; bindingId: string; service: string; state: State }
  | { action: "boundary.created"; boundaryId: string; service: string; state: State }
  | { action: "user.adopted"; userId: string; fromUserId: string; bindingIds: string[] };

export interface BindingKey {
  service: string;
  kind: string;
  workspace: string;
  value: string;
}
export interface BoundaryKey {
  service: string;
  workspace: string;
  value: string;
}

const RANK: Record<State, number> = { declared: 0, observed: 1, verified: 2 };
const LOWER_THAN: Record<State, State[]> = { declared: [], observed: ["declared"], verified: ["declared", "observed"] };

type Tx = DbClient | undefined;
const h = (tx: Tx): DbClient => tx ?? globalDb;
/** Run `fn` in the caller's transaction, or open one. */
async function inTx<T>(tx: Tx, fn: (c: DbClient) => Promise<T>): Promise<T> {
  return tx ? fn(tx) : globalDb.transaction(fn);
}
const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

function needWorkspace(service: string, workspace: string): void {
  if (service === "slack" && workspace === "") throw new Error("a slack record needs a workspace id");
}

export async function ensureUser(i: { kind?: UserKind; displayName?: string | null } = {}, tx?: DbClient): Promise<UserRow> {
  const now = Date.now();
  const id = randomUUID();
  await h(tx).run(
    "INSERT INTO users (id, kind, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [id, i.kind ?? "person", i.displayName ?? null, now, now],
  );
  return (await getUser(id, tx))!;
}

export async function getUser(id: string, tx?: DbClient): Promise<UserRow | null> {
  return h(tx).one<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
}

export async function findBinding(k: BindingKey, tx?: DbClient): Promise<BindingRow | null> {
  return h(tx).one<BindingRow>(
    "SELECT * FROM bindings WHERE service = ? AND kind = ? AND workspace = ? AND value = ?",
    [k.service, k.kind, k.workspace, k.value],
  );
}

export async function findBoundary(k: BoundaryKey, tx?: DbClient): Promise<BoundaryRow | null> {
  return h(tx).one<BoundaryRow>("SELECT * FROM boundaries WHERE service = ? AND workspace = ? AND value = ?", [k.service, k.workspace, k.value]);
}

export async function getBoundary(id: string, tx?: DbClient): Promise<BoundaryRow | null> {
  return h(tx).one<BoundaryRow>("SELECT * FROM boundaries WHERE id = ?", [id]);
}

/** Raise a binding's state (never lower it). */
async function raiseBinding(c: DbClient, id: string, state: State, source: string | undefined, now: number): Promise<void> {
  const lower = LOWER_THAN[state];
  if (lower.length === 0) return;
  await c.run(
    `UPDATE bindings SET state = ?, updated_at = ?, verified_at = ?${source ? ", source = ?" : ""}
     WHERE id = ? AND state IN (${marks(lower.length)})`,
    [state, now, state === "verified" ? now : null, ...(source ? [source] : []), id, ...lower],
  );
}

export interface EnsureBindingInput extends BindingKey {
  state: State;
  source: string;
  userId?: string;
}
export interface EnsureBindingResult {
  binding: BindingRow;
  userId: string;
  created: boolean;
  events: DomainEvent[];
}

/**
 * Insert-or-ignore on the unique key, then re-read. Creates a user when no
 * `userId` is given and no user holds the binding. An existing binding keeps
 * its user (moving one is `adoptBinding`) and only has its state raised.
 */
export async function ensureBinding(i: EnsureBindingInput, tx?: DbClient): Promise<EnsureBindingResult> {
  needWorkspace(i.service, i.workspace);
  return inTx(tx, async (c) => {
    const key: BindingKey = { service: i.service, kind: i.kind, workspace: i.workspace, value: i.value };
    const events: DomainEvent[] = [];
    const existing = await findBinding(key, c);
    if (existing) {
      await raiseBinding(c, existing.id, i.state, i.source, Date.now());
      const binding = (await findBinding(key, c))!;
      return { binding, userId: binding.user_id, created: false, events };
    }
    let userId = i.userId;
    let madeUser = false;
    if (userId) {
      const u = await getUser(userId, c);
      if (!u) throw new Error("user does not exist");
    } else {
      userId = (await ensureUser({}, c)).id;
      madeUser = true;
    }
    const now = Date.now();
    const id = randomUUID();
    const r = await c.run(
      `INSERT INTO bindings (id, user_id, service, kind, workspace, value, state, source, created_at, updated_at, verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (service, kind, workspace, value) DO NOTHING`,
      [id, userId, i.service, i.kind, i.workspace, i.value, i.state, i.source, now, now, i.state === "verified" ? now : null],
    );
    if (r.changes === 0) {
      // Lost a race: another writer holds the key. Drop the user made for it.
      if (madeUser) await c.run("DELETE FROM users WHERE id = ?", [userId]);
      await raiseBinding(c, (await findBinding(key, c))!.id, i.state, i.source, now);
      const binding = (await findBinding(key, c))!;
      return { binding, userId: binding.user_id, created: false, events };
    }
    if (madeUser) events.push({ action: "user.created", userId });
    events.push({ action: "binding.created", userId, bindingId: id, service: i.service, state: i.state });
    return { binding: (await findBinding(key, c))!, userId, created: true, events };
  });
}

export interface EnsureBoundaryInput extends BoundaryKey {
  kind: string;
  state: State;
  displayName?: string | null;
}
export interface EnsureBoundaryResult {
  boundary: BoundaryRow;
  created: boolean;
  events: DomainEvent[];
}

export async function ensureBoundary(i: EnsureBoundaryInput, tx?: DbClient): Promise<EnsureBoundaryResult> {
  needWorkspace(i.service, i.workspace);
  return inTx(tx, async (c) => {
    const key: BoundaryKey = { service: i.service, workspace: i.workspace, value: i.value };
    const now = Date.now();
    const id = randomUUID();
    const r = await c.run(
      `INSERT INTO boundaries (id, kind, display_name, service, workspace, value, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (service, workspace, value) DO NOTHING`,
      [id, i.kind, i.displayName ?? null, i.service, i.workspace, i.value, i.state, now, now],
    );
    const created = r.changes > 0;
    const lower = LOWER_THAN[i.state];
    if (!created && lower.length > 0) {
      await c.run(
        `UPDATE boundaries SET state = ?, updated_at = ?
         WHERE service = ? AND workspace = ? AND value = ? AND state IN (${marks(lower.length)})`,
        [i.state, now, i.service, i.workspace, i.value, ...lower],
      );
    }
    const boundary = (await findBoundary(key, c))!;
    return {
      boundary,
      created,
      events: created ? [{ action: "boundary.created", boundaryId: boundary.id, service: i.service, state: i.state }] : [],
    };
  });
}

/** The binding to show for a user: a verified email, else a Slack binding (verified first, oldest first). */
export async function preferredBinding(userId: string, tx?: DbClient): Promise<BindingRow | null> {
  const c = h(tx);
  const mail = await c.one<BindingRow>(
    "SELECT * FROM bindings WHERE user_id = ? AND service = 'email' AND state = 'verified' ORDER BY created_at, id LIMIT 1",
    [userId],
  );
  if (mail) return mail;
  return c.one<BindingRow>(
    `SELECT * FROM bindings WHERE user_id = ? AND service = 'slack'
     ORDER BY CASE state WHEN 'verified' THEN 0 WHEN 'observed' THEN 1 ELSE 2 END, created_at, id LIMIT 1`,
    [userId],
  );
}

const ALIAS_DEPTH = 16;

/** The live user id for an id, following `user_aliases`. Null when it names no user and no alias. */
export async function resolveUserId(id: string, tx?: DbClient): Promise<string | null> {
  const c = h(tx);
  let cur = id;
  const seen = new Set<string>();
  for (let n = 0; n < ALIAS_DEPTH && !seen.has(cur); n++) {
    seen.add(cur);
    if (await getUser(cur, c)) return cur;
    const a = await c.one<{ user_id: string }>("SELECT user_id FROM user_aliases WHERE old_id = ?", [cur]);
    if (!a) return null;
    cur = a.user_id;
  }
  return null;
}

export interface AdoptInput extends BindingKey {
  toUserId: string;
  state: "verified";
}
export interface AdoptResult {
  adopted: boolean;
  conflict?: true;
  movedBindingIds: string[];
  binding: BindingRow | null;
  events: DomainEvent[];
}

/**
 * A verified proof (portal link, OIDC login) targets a value. If another user
 * holds it and none of that user's bindings is verified, all of that user's
 * bindings move to `toUserId` and the old id becomes an alias. If the other
 * user holds anything verified, nothing changes and `conflict` is set: two
 * verified records are never merged here.
 *
 * Concurrent adopts of one held binding: on Postgres the holder's user row is
 * locked first and re-read, and the move must change exactly the rows read, or
 * nothing is written and `conflict` is set. A passed `tx` must be a
 * transaction (the move runs under a savepoint).
 */
export async function adoptBinding(i: AdoptInput, tx?: DbClient): Promise<AdoptResult> {
  needWorkspace(i.service, i.workspace);
  return inTx(tx, async (c) => {
    const toUserId = await resolveUserId(i.toUserId, c);
    if (!toUserId) throw new Error("user does not exist");
    const key: BindingKey = { service: i.service, kind: i.kind, workspace: i.workspace, value: i.value };
    const held = await findBinding(key, c);
    if (!held) {
      const r = await ensureBinding({ ...key, state: "verified", source: "adopt", userId: toUserId }, c);
      return { adopted: false, movedBindingIds: [], binding: r.binding, events: r.events };
    }
    const now = Date.now();
    if (held.user_id === toUserId) {
      await raiseBinding(c, held.id, "verified", undefined, now);
      return { adopted: false, movedBindingIds: [], binding: (await findBinding(key, c))!, events: [] };
    }
    const conflict: AdoptResult = { adopted: false, conflict: true, movedBindingIds: [], binding: held, events: [] };
    if (c.dialect === "pg") {
      // READ COMMITTED: two adopts of the same held binding would both read the holder's bindings and both move them.
      // Lock the holder row, then re-read: the loser of the lock sees the winner's result (or no holder at all).
      if (!(await c.one("SELECT id FROM users WHERE id = ? FOR UPDATE", [held.user_id]))) return conflict;
      const again = await findBinding(key, c);
      if (!again || again.user_id !== held.user_id) return conflict;
    }
    const theirs = await c.query<BindingRow>("SELECT * FROM bindings WHERE user_id = ? ORDER BY created_at, id", [held.user_id]);
    if (theirs.some((b) => RANK[b.state] === RANK.verified)) return conflict;
    const moved = theirs.map((b) => b.id);
    // A savepoint so a mismatch below undoes the partial move, whatever transaction the caller holds.
    await c.exec("SAVEPOINT adopt_move");
    const upd = await c.run("UPDATE bindings SET user_id = ?, updated_at = ? WHERE user_id = ?", [toUserId, now, held.user_id]);
    if ((upd.changes ?? 0) !== moved.length) {
      // The rows moved under us (a stale read): write nothing, no event.
      await c.exec("ROLLBACK TO SAVEPOINT adopt_move");
      await c.exec("RELEASE SAVEPOINT adopt_move");
      return conflict;
    }
    await c.run("INSERT INTO user_aliases (old_id, user_id, merged_at) VALUES (?, ?, ?) ON CONFLICT (old_id) DO NOTHING", [held.user_id, toUserId, now]);
    // Aliases that pointed at the old user now point at the new one.
    await c.run("UPDATE user_aliases SET user_id = ? WHERE user_id = ? AND old_id <> ?", [toUserId, held.user_id, held.user_id]);
    await c.run("DELETE FROM users WHERE id = ?", [held.user_id]);
    await c.exec("RELEASE SAVEPOINT adopt_move");
    await raiseBinding(c, held.id, "verified", undefined, now);
    return {
      adopted: true,
      movedBindingIds: moved,
      binding: (await findBinding(key, c))!,
      events: [{ action: "user.adopted", userId: toUserId, fromUserId: held.user_id, bindingIds: moved }],
    };
  });
}
