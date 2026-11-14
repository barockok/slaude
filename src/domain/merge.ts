/**
 * The merge engine (slice C, task 25): two user records become one, in one
 * transaction, with a ledger row that is the authority for undo.
 *
 * What it does
 *  - Resolves both ids through aliases. Two ids that name one live record are an
 *    idempotent no-op that returns the ledger row of the merge that made them one.
 *  - Locks both user rows in ascending id order (FOR UPDATE on Postgres; on
 *    sqlite the write transaction is BEGIN IMMEDIATE when the engine opens it,
 *    and a no-op write on each row takes the same lock inside a caller's
 *    transaction), then re-resolves and re-reads.
 *  - REFUSES, and writes a proposal for a human instead, when the loser holds
 *    any verified binding, when either record is a bot or an agent, when two
 *    different verified emails would land on one record, or when a veto names
 *    the (Slack binding, oidc binding) pair. `SLAUDE_AUTO_MERGE=off` refuses an
 *    automatic (proof) merge the same way. Console merges are checked too.
 *  - Moves bindings, stored grant subjects and aliases under a savepoint with
 *    compare-and-set: rows changed must equal rows read, else everything done
 *    is rolled back and nothing is written (`stale`).
 *  - Deletes the loser, diffs the grants that reach the survivor before and
 *    after (`activated`, `inactive_privileged`) and writes the ledger.
 *  - A merge never raises a binding state, except the proof path's own adopt
 *    (`raise`), which is recorded in `raised`.
 *  - After the commit: the `user.merged` audit event, actor cache invalidation
 *    and the notice hook (`emitDomainEvents` does all three). With a caller's
 *    transaction the event is returned in `events` for the caller to emit after
 *    its own commit.
 *
 * Authorization is untouched: this changes who owns data, and every decision
 * path keeps reading the same records through the same functions.
 */
import { randomUUID } from "node:crypto";
import * as Domain from "../db/domain";
import type { BindingRow, DomainEvent, UserRow } from "../db/domain";
import { db as globalDb, type DbClient } from "../db/schema";
import { emitDomainEvents } from "../audit/domain";
import { env } from "../config/env";
import { m } from "../metrics";
import { diffReach, grantsReaching, type GrantDiff } from "./merge-reach";

/** D1: how long a merge can be undone. */
export const UNDO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type MergeKind = "proof" | "console";
export type RefusalReason = "verified-loser" | "bot-or-agent" | "two-emails" | "veto" | "auto-merge-off" | "stale";

export interface MergeInput {
  survivorId: string;
  loserId: string;
  kind: MergeKind;
  /** `system` for a proof merge, the operator's id for a console merge. */
  actor: string;
  /** Let the survivor rule choose between the two records (console); otherwise `survivorId` survives. */
  pickSurvivor?: boolean;
  /** The link a proof merge rests on (binding ids, never values). */
  proof?: { slackBindingId?: string | null; oidcBindingId?: string | null };
  /** The proof path's own binding: raised to verified after the move and recorded in `raised`. */
  raise?: { bindingId: string };
}

export interface MovedShape {
  loser: { id: string; kind: string; display_name: string | null; created_at: number };
  bindings: Array<{ id: string; from: string; to: string }>;
  raised: Array<{ binding_id: string; from_state: string; to_state: string; verified_at: number | null }>;
  grants: Array<{ id: string; persona: string; from: string; to: string }>;
  aliases_added: string[];
  aliases_repointed: Array<{ old_id: string; from: string; to: string }>;
  proof_binding_ids: { slack: string | null; oidc: string | null };
  activated: Array<{ persona: string; role: string; source: string; entry: string; privileged: boolean }>;
  inactive_privileged: Array<{ persona: string; role: string; entry: string }>;
}

export interface MergeRow {
  id: string;
  created_at: number;
  kind: MergeKind;
  survivor_id: string;
  loser_id: string;
  state: "applied" | "undone";
  actor: string;
  proof: { slack?: string | null; oidc?: string | null };
  moved: MovedShape;
  audit_event_id: string | null;
  undo_until: number;
  undone_at: number | null;
  undone_by: string | null;
  notice_state: "pending" | "sent" | "failed" | "skipped";
}

export type MergeOutcome =
  | { status: "merged"; merge: MergeRow; survivorId: string; loserId: string; movedBindingIds: string[]; events: DomainEvent[] }
  | { status: "noop"; merge: MergeRow | null; survivorId: string }
  | { status: "refused"; reason: RefusalReason; proposalId?: string; survivorId: string; loserId: string };

type Raw = Omit<MergeRow, "proof" | "moved"> & { proof: string; moved: string };

export function parseMergeRow(r: Raw): MergeRow {
  return { ...r, created_at: Number(r.created_at), undo_until: Number(r.undo_until), undone_at: r.undone_at === null ? null : Number(r.undone_at), proof: JSON.parse(r.proof), moved: JSON.parse(r.moved) };
}

export async function getMerge(id: string, c: DbClient = globalDb): Promise<MergeRow | null> {
  const r = await c.one<Raw>("SELECT * FROM user_merges WHERE id = ?", [id]);
  return r ? parseMergeRow(r) : null;
}

/** The applied ledger row that merged either id away, newest first. */
async function appliedFor(ids: string[], c: DbClient): Promise<MergeRow | null> {
  const r = await c.one<Raw>(
    `SELECT * FROM user_merges WHERE state = 'applied' AND loser_id IN (${ids.map(() => "?").join(", ")}) ORDER BY created_at DESC, id LIMIT 1`,
    ids,
  );
  return r ? parseMergeRow(r) : null;
}

/** A pair a human settles, stored in id order. Existing proposals (open or settled) are left as they are. */
export async function proposeMerge(
  c: DbClient,
  a: string,
  b: string,
  reason: "conflict" | "two-emails",
  evidence: Record<string, unknown>,
): Promise<string> {
  const [x, y] = a < b ? [a, b] : [b, a];
  await c.run(
    `INSERT INTO merge_proposals (id, created_at, user_a, user_b, reason, state, evidence) VALUES (?, ?, ?, ?, ?, 'open', ?)
     ON CONFLICT (user_a, user_b, reason) DO NOTHING`,
    [randomUUID(), Date.now(), x, y, reason, JSON.stringify(evidence)],
  );
  return (await c.one<{ id: string }>("SELECT id FROM merge_proposals WHERE user_a = ? AND user_b = ? AND reason = ?", [x, y, reason]))!.id;
}

/** Take the row lock on both users, lowest id first. Postgres: FOR UPDATE. sqlite: a no-op write (the write lock). */
export async function lockUsers(c: DbClient, ids: string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) {
    if (c.dialect === "pg") await c.one("SELECT id FROM users WHERE id = ? FOR UPDATE", [id]);
    else await c.run("UPDATE users SET updated_at = updated_at WHERE id = ?", [id]);
  }
}

const sameKey = (x: string, y: string) => x === y;

/**
 * Merge `loserId` into `survivorId` (or the other way round when
 * `pickSurvivor` says the rule chooses). Pass the caller's `tx` to join it (the
 * events come back for the caller to emit after its commit); without one the
 * engine opens its own transaction and emits after it commits.
 */
export async function mergeUsers(i: MergeInput, tx?: DbClient): Promise<MergeOutcome> {
  if (tx) return count(i, await run(i, tx));
  const out = await globalDb.transaction((c) => run(i, c), { immediate: true });
  if (out.status === "merged") await emitDomainEvents(out.events);
  return count(i, out);
}

function count(i: MergeInput, out: MergeOutcome): MergeOutcome {
  m.userMergesTotal.inc({ kind: i.kind, result: out.status });
  return out;
}

async function run(i: MergeInput, c: DbClient): Promise<MergeOutcome> {
  // 1. Resolve through aliases, lock, re-resolve until the locked set is the live set.
  const live = async (id: string) => {
    const r = await Domain.resolveUserId(id, c);
    if (!r) throw new Error("user does not exist");
    return r;
  };
  let S = await live(i.survivorId);
  let L = await live(i.loserId);
  const locked = new Set<string>();
  for (let n = 0; n < 4; n++) {
    await lockUsers(c, [S, L].filter((x) => !locked.has(x)));
    locked.add(S);
    locked.add(L);
    const S2 = await Domain.resolveUserId(i.survivorId, c);
    const L2 = await Domain.resolveUserId(i.loserId, c);
    if (S2 === S && L2 === L) break;
    if (!S2 || !L2) throw new Error("user does not exist");
    S = S2;
    L = L2;
  }
  if (sameKey(S, L)) return { status: "noop", merge: await appliedFor([...new Set([i.loserId, i.survivorId, L])], c), survivorId: S };

  // 2. Re-read under the lock. The loser's bindings are read first, in the one query form the adopt race test intercepts.
  const loserUser = (await Domain.getUser(L, c)) as UserRow;
  const survUser = (await Domain.getUser(S, c)) as UserRow;
  let loserBindings = await c.query<BindingRow>("SELECT * FROM bindings WHERE user_id = ? ORDER BY created_at, id", [L]);
  let survBindings = await c.query<BindingRow>("SELECT * FROM bindings WHERE user_id = ? ORDER BY created_at, id", [S]);

  // 3. Survivor rule (console): the record holding something verified, else the older, ties by id.
  let loser = loserUser;
  let surv = survUser;
  if (i.pickSurvivor) {
    const lv = loserBindings.some((b) => b.state === "verified");
    const sv = survBindings.some((b) => b.state === "verified");
    const swap = lv !== sv ? lv : loserUser.created_at !== survUser.created_at ? loserUser.created_at < survUser.created_at : loserUser.id < survUser.id;
    if (swap) {
      [S, L] = [L, S];
      [loser, surv] = [survUser, loserUser];
      [loserBindings, survBindings] = [survBindings, loserBindings];
    }
  }

  // 4. Refusals: a human decides these.
  const refuse = async (reason: RefusalReason, proposal?: "conflict" | "two-emails"): Promise<MergeOutcome> => {
    const proposalId = proposal
      ? await proposeMerge(c, S, L, proposal, { why: reason, kind: i.kind, survivor_bindings: survBindings.map((b) => b.id), loser_bindings: loserBindings.map((b) => b.id) })
      : undefined;
    return { status: "refused", reason, ...(proposalId ? { proposalId } : {}), survivorId: S, loserId: L };
  };
  if (i.kind === "proof" && !env.merge.auto()) return refuse("auto-merge-off", "conflict");
  if (loser.kind !== "person" || surv.kind !== "person") return refuse("bot-or-agent", "conflict");
  if (loserBindings.some((b) => b.state === "verified")) return refuse("verified-loser", "conflict");
  const allIds = [...loserBindings, ...survBindings].map((b) => b.id);
  if (allIds.length > 0) {
    const ph = allIds.map(() => "?").join(", ");
    const vetoes = await c.query<{ slack_binding_id: string; oidc_binding_id: string }>(
      `SELECT slack_binding_id, oidc_binding_id FROM merge_vetoes WHERE slack_binding_id IN (${ph}) AND oidc_binding_id IN (${ph})`,
      [...allIds, ...allIds],
    );
    const onLoser = new Set(loserBindings.map((b) => b.id));
    if (vetoes.some((v) => onLoser.has(v.slack_binding_id) !== onLoser.has(v.oidc_binding_id))) return refuse("veto", "conflict");
  }
  const raise = i.raise ? loserBindings.find((b) => b.id === i.raise!.bindingId) : undefined;
  if (raise && raise.service === "email") {
    const other = survBindings.find((b) => b.service === "email" && b.state === "verified" && b.value !== raise.value);
    if (other) return refuse("two-emails", "two-emails");
  }

  // 5. The move, under a savepoint so any failure leaves nothing behind.
  const before = await grantsReaching(S, c);
  const now = Date.now();
  await c.exec("SAVEPOINT merge_move");
  const rollback = async () => {
    await c.exec("ROLLBACK TO SAVEPOINT merge_move");
    await c.exec("RELEASE SAVEPOINT merge_move");
  };
  try {
    const upd = await c.run("UPDATE bindings SET user_id = ?, updated_at = ? WHERE user_id = ?", [S, now, L]);
    if ((upd.changes ?? 0) !== loserBindings.length) {
      await rollback(); // the rows moved under us (a stale read): write nothing
      return { status: "refused", reason: "stale", survivorId: S, loserId: L };
    }
    const grantRows = await c.query<{ id: string; persona: string }>("SELECT id, persona FROM agent_grants WHERE subject_user_id = ? ORDER BY id", [L]);
    const gupd = await c.run("UPDATE agent_grants SET subject_user_id = ? WHERE subject_user_id = ?", [S, L]);
    if ((gupd.changes ?? 0) !== grantRows.length) {
      await rollback();
      return { status: "refused", reason: "stale", survivorId: S, loserId: L };
    }
    const repointed = await c.query<{ old_id: string }>("SELECT old_id FROM user_aliases WHERE user_id = ? AND old_id <> ? ORDER BY old_id", [L, L]);
    const aupd = await c.run("UPDATE user_aliases SET user_id = ? WHERE user_id = ? AND old_id <> ?", [S, L, L]);
    if ((aupd.changes ?? 0) !== repointed.length) {
      await rollback();
      return { status: "refused", reason: "stale", survivorId: S, loserId: L };
    }
    const added = await c.run("INSERT INTO user_aliases (old_id, user_id, merged_at) VALUES (?, ?, ?) ON CONFLICT (old_id) DO NOTHING", [L, S, now]);
    await c.run("DELETE FROM users WHERE id = ?", [L]);

    const raised: MovedShape["raised"] = [];
    if (raise) {
      const prior = raise.state;
      await Domain.raiseBinding(c, raise.id, "verified", undefined, now);
      const after = await Domain.findBinding({ service: raise.service, kind: raise.kind, workspace: raise.workspace, value: raise.value }, c);
      if (after && after.state === "verified" && prior !== "verified") raised.push({ binding_id: raise.id, from_state: prior, to_state: "verified", verified_at: after.verified_at });
    }

    const diff: GrantDiff = diffReach(before, await grantsReaching(S, c));
    const moved: MovedShape = {
      loser: { id: L, kind: loser.kind, display_name: loser.display_name, created_at: Number(loser.created_at) },
      bindings: loserBindings.map((b) => ({ id: b.id, from: L, to: S })),
      raised,
      grants: grantRows.map((g) => ({ id: g.id, persona: g.persona, from: L, to: S })),
      aliases_added: (added.changes ?? 0) > 0 ? [L] : [],
      aliases_repointed: repointed.map((a) => ({ old_id: a.old_id, from: L, to: S })),
      proof_binding_ids: { slack: i.proof?.slackBindingId ?? null, oidc: i.proof?.oidcBindingId ?? null },
      activated: diff.activated,
      inactive_privileged: diff.inactivePrivileged,
    };
    const id = randomUUID();
    await c.run(
      `INSERT INTO user_merges (id, created_at, kind, survivor_id, loser_id, state, actor, proof, moved, undo_until, notice_state)
       VALUES (?, ?, ?, ?, ?, 'applied', ?, ?, ?, ?, 'pending')`,
      [id, now, i.kind, S, L, i.actor, JSON.stringify({ slack: moved.proof_binding_ids.slack, oidc: moved.proof_binding_ids.oidc }), JSON.stringify(moved), now + UNDO_WINDOW_MS],
    );
    await c.exec("RELEASE SAVEPOINT merge_move");
    const merge = (await getMerge(id, c))!;
    const events: DomainEvent[] = [
      {
        action: "user.merged", mergeId: id, survivorId: S, loserId: L, kind: i.kind, actor: i.actor,
        bindingIds: moved.bindings.map((b) => b.id), grantIds: moved.grants.map((g) => g.id), raisedBindingIds: raised.map((r) => r.binding_id),
        activated: moved.activated.length, inactivePrivileged: moved.inactive_privileged.length,
      },
    ];
    return { status: "merged", merge, survivorId: S, loserId: L, movedBindingIds: moved.bindings.map((b) => b.id), events };
  } catch (e) {
    await rollback();
    throw e;
  }
}
