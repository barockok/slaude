/**
 * Undo of a user merge (slice C, task 28). The ledger row (`user_merges.moved`)
 * is the authority, not the audit trail, which retention can purge (D14).
 *
 * Allowed while the merge is `applied` and before `undo_until` (D1: 7 days).
 * One transaction: lock the survivor, recreate the loser row with its original
 * id, then give back each ledger item ONLY when it is still where the merge put
 * it. Anything changed since is left as it is and listed in `skipped` with the
 * reason. Concretely:
 *  - bindings and stored grants go back when their current owner equals the
 *    ledger's `to`; aliases the merge repointed go back the same way and the
 *    alias for the loser id is dropped;
 *  - a binding STATE is restored only for entries in `raised`, only when the
 *    binding went back to the loser and is still verified with the recorded
 *    `verified_at`. Undo never lowers any other binding;
 *  - a proof merge ALSO removes the `slack_identities` row the proof rested on
 *    (the link row only; the account stays), so the person is no longer linked,
 *    and inserts a veto on the hashed (Slack or email, sign-in) key pair that
 *    `linkSlackIdentity` and the merge engine refuse until an operator lifts it.
 *
 * Limits (shown in the console and the release note): records and grants only
 * (credentials and memory slices never moved); items changed after the merge
 * are not reverted; past the window undo is refused; a merge that a later merge
 * chained onto must be undone later-first; a deleted account is not restored.
 *
 * `previewUndo` returns the same lists without writing.
 */
import { randomUUID } from "node:crypto";
import * as Domain from "../db/domain";
import type { DomainEvent } from "../db/domain";
import { db as globalDb, type DbClient } from "../db/schema";
import { emitDomainEvents } from "../audit/domain";
import { m } from "../metrics";
import { getMerge, lockUsers, type MergeRow } from "./merge";

export type UndoRefusal = "not-found" | "already-undone" | "past-window" | "chained" | "survivor-gone" | "loser-exists";

export const UNDO_REFUSAL_TEXT: Record<UndoRefusal, string> = {
  "not-found": "no such merge",
  "already-undone": "this merge was already undone",
  "past-window": "the undo window has passed",
  chained: "a later merge was chained onto the survivor: undo that merge first",
  "survivor-gone": "the surviving record no longer exists",
  "loser-exists": "a record with the merged-away id exists again",
};

export interface UndoSkip {
  kind: "binding" | "grant" | "alias" | "state" | "link";
  id: string;
  reason: string;
}

export interface UndoLists {
  moved: {
    /** Binding ids given back to the loser. */
    bindings: string[];
    /** Stored grant ids repointed back to the loser. */
    grants: string[];
    /** Alias ids restored or removed (the loser's own alias is removed). */
    aliases: string[];
    /** Binding ids whose state went back to what it was before the merge raised it. */
    restored: string[];
    /** The `slack_identities` link row of a proof merge was removed. */
    unlinked: boolean;
  };
  skipped: UndoSkip[];
}

export type UndoOutcome =
  | ({ status: "undone"; merge: MergeRow; events: DomainEvent[] } & UndoLists)
  | ({ status: "preview"; merge: MergeRow } & UndoLists)
  | { status: "refused"; reason: UndoRefusal; message: string };

const refuse = (reason: UndoRefusal): UndoOutcome => ({ status: "refused", reason, message: UNDO_REFUSAL_TEXT[reason] });
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

interface Plan extends UndoLists {
  bindingMoves: string[];
  grantMoves: string[];
  aliasRepoints: Array<{ old_id: string; from: string; to: string }>;
  aliasRemoves: string[];
  stateRestores: Array<{ id: string; to_state: string; verified_at: number | null }>;
  unlink: { teamId: string; slackUserId: string; accountId: string } | null;
  veto: [string, string] | null;
}

/** Why a merge cannot be undone right now, from what is readable without a lock. */
async function refusal(merge: MergeRow | null, c: DbClient, now: number): Promise<UndoRefusal | null> {
  if (!merge) return "not-found";
  if (merge.state !== "applied") return "already-undone";
  if (now >= merge.undo_until) return "past-window";
  if (!(await Domain.getUser(merge.survivor_id, c))) {
    const later = await c.one("SELECT id FROM user_merges WHERE state = 'applied' AND loser_id = ?", [merge.survivor_id]);
    return later ? "chained" : "survivor-gone";
  }
  if (await Domain.getUser(merge.loser_id, c)) return "loser-exists";
  return null;
}

/** What an undo would do right now. Read only. */
async function plan(merge: MergeRow, c: DbClient): Promise<Plan> {
  const mv = merge.moved;
  const S = merge.survivor_id;
  const out: Plan = {
    moved: { bindings: [], grants: [], aliases: [], restored: [], unlinked: false },
    skipped: [],
    bindingMoves: [], grantMoves: [], aliasRepoints: [], aliasRemoves: [], stateRestores: [], unlink: null, veto: null,
  };
  const bindingNow = new Map<string, { user_id: string; state: string; verified_at: number | string | null; service: string; workspace: string; value: string }>();
  const readBinding = async (id: string) => {
    if (!bindingNow.has(id)) {
      const r = await c.one<{ user_id: string; state: string; verified_at: number | string | null; service: string; workspace: string; value: string }>(
        "SELECT user_id, state, verified_at, service, workspace, value FROM bindings WHERE id = ?",
        [id],
      );
      if (r) bindingNow.set(id, r);
      return r;
    }
    return bindingNow.get(id)!;
  };

  for (const b of mv.bindings) {
    const r = await readBinding(b.id);
    if (!r) out.skipped.push({ kind: "binding", id: b.id, reason: "the binding no longer exists (removed since the merge)" });
    else if (r.user_id !== b.to) out.skipped.push({ kind: "binding", id: b.id, reason: "the binding belongs to another record now" });
    else out.bindingMoves.push(b.id);
  }
  for (const g of mv.grants) {
    const r = await c.one<{ subject_user_id: string | null }>("SELECT subject_user_id FROM agent_grants WHERE id = ?", [g.id]);
    if (!r) out.skipped.push({ kind: "grant", id: g.id, reason: "the grant no longer exists (revoked since the merge)" });
    else if (r.subject_user_id !== g.to) out.skipped.push({ kind: "grant", id: g.id, reason: "the grant names another record now" });
    else out.grantMoves.push(g.id);
  }
  for (const a of mv.aliases_repointed) {
    const r = await c.one<{ user_id: string }>("SELECT user_id FROM user_aliases WHERE old_id = ?", [a.old_id]);
    if (!r) out.skipped.push({ kind: "alias", id: a.old_id, reason: "the alias no longer exists" });
    else if (r.user_id !== a.to) out.skipped.push({ kind: "alias", id: a.old_id, reason: "the alias points to another record now" });
    else out.aliasRepoints.push(a);
  }
  for (const id of mv.aliases_added) {
    const r = await c.one<{ user_id: string }>("SELECT user_id FROM user_aliases WHERE old_id = ?", [id]);
    if (!r) continue; // already gone: nothing to undo
    if (r.user_id === S) out.aliasRemoves.push(id);
    else out.skipped.push({ kind: "alias", id, reason: "the alias points to another record now" });
  }
  for (const r of mv.raised) {
    const b = await readBinding(r.binding_id);
    if (!b) out.skipped.push({ kind: "state", id: r.binding_id, reason: "the binding no longer exists, so there is no state to restore" });
    else if (!out.bindingMoves.includes(r.binding_id)) out.skipped.push({ kind: "state", id: r.binding_id, reason: "the binding did not go back to the merged-away record, so its state is left" });
    else if (b.state !== "verified") out.skipped.push({ kind: "state", id: r.binding_id, reason: `the binding is ${b.state} now, not verified: left as it is` });
    else if (num(b.verified_at) !== num(r.verified_at)) out.skipped.push({ kind: "state", id: r.binding_id, reason: "the binding was verified again after the merge: left verified" });
    else out.stateRestores.push({ id: r.binding_id, to_state: r.from_state, verified_at: num(r.verified_at) });
  }

  // The pair an undo forbids (a link, or a login's email) is in the ledger by key, so it holds even when the bindings are gone.
  if (merge.kind === "proof" && mv.veto_pair) out.veto = mv.veto_pair;
  // A proof merge rested on a link: the slack_identities row goes, the account stays.
  if (merge.kind === "proof" && mv.proof_binding_ids.slack && mv.proof_binding_ids.oidc) {
    const sb = await readBinding(mv.proof_binding_ids.slack);
    const ob = await readBinding(mv.proof_binding_ids.oidc);
    if (!sb || !ob) {
      out.skipped.push({ kind: "link", id: mv.proof_binding_ids.slack, reason: "already unlinked: the link or the account was removed after the merge" });
    } else {
      const acct = await c.one<{ id: string }>("SELECT id FROM accounts WHERE issuer = ? AND subject = ?", [ob.workspace, ob.value]);
      const row = acct ? await c.one<{ account_id: string }>("SELECT account_id FROM slack_identities WHERE team_id = ? AND slack_user_id = ?", [sb.workspace, sb.value]) : null;
      if (!acct || !row) out.skipped.push({ kind: "link", id: mv.proof_binding_ids.slack, reason: "already unlinked after the merge: it stays unlinked" });
      else if (row.account_id !== acct.id) out.skipped.push({ kind: "link", id: mv.proof_binding_ids.slack, reason: "the Slack account is linked to a different account now: left as it is" });
      else out.unlink = { teamId: sb.workspace, slackUserId: sb.value, accountId: acct.id };
    }
  }

  out.moved = {
    bindings: [...out.bindingMoves],
    grants: [...out.grantMoves],
    aliases: [...out.aliasRepoints.map((a) => a.old_id), ...out.aliasRemoves],
    restored: out.stateRestores.map((s) => s.id),
    unlinked: out.unlink !== null,
  };
  return out;
}

/** The same lists an undo would return, without writing anything (or locking). */
export async function previewUndo(mergeId: string, c: DbClient = globalDb, now: number = Date.now()): Promise<UndoOutcome> {
  const merge = await getMerge(mergeId, c);
  const why = await refusal(merge, c, now);
  if (why) return refuse(why);
  const p = await plan(merge!, c);
  return { status: "preview", merge: merge!, moved: p.moved, skipped: p.skipped };
}

export interface UndoInput {
  mergeId: string;
  /** The operator's id. */
  actor: string;
  /** Why (required by the console); recorded in the audit event. */
  reason: string;
}

/**
 * Undo a merge. Pass the caller's `tx` to join it (the events come back for
 * the caller to emit after its commit); without one the undo opens its own
 * transaction and emits after it commits.
 */
export async function undoMerge(i: UndoInput, tx?: DbClient): Promise<UndoOutcome> {
  if (tx) return count(await run(i, tx));
  const out = await globalDb.transaction((c) => run(i, c), { immediate: true });
  if (out.status === "undone") await emitDomainEvents(out.events);
  return count(out);
}

function count(out: UndoOutcome): UndoOutcome {
  m.userMergeUndoTotal.inc({ result: out.status });
  return out;
}

async function run(i: UndoInput, c: DbClient): Promise<UndoOutcome> {
  const first = await getMerge(i.mergeId, c);
  if (!first) return refuse("not-found");
  // Lock the survivor first: a concurrent merge of it, or a concurrent undo, waits here, then re-reads.
  await lockUsers(c, [first.survivor_id]);
  const merge = (await getMerge(i.mergeId, c))!;
  const now = Date.now();
  const why = await refusal(merge, c, now);
  if (why) return refuse(why);

  const p = await plan(merge, c);
  const L = merge.loser_id;
  const S = merge.survivor_id;
  const mv = merge.moved;
  const skipped: UndoSkip[] = [...p.skipped];
  const moved: UndoLists["moved"] = { bindings: [], grants: [], aliases: [], restored: [], unlinked: false };

  // The loser's row comes back with the id, kind, name and age the ledger kept.
  await c.run("INSERT INTO users (id, kind, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [L, mv.loser.kind, mv.loser.display_name, mv.loser.created_at, now]);

  // Each step is compare-and-set on the owner the plan read: a row that changed in between is skipped, never overwritten.
  for (const id of p.bindingMoves) {
    const r = await c.run("UPDATE bindings SET user_id = ?, updated_at = ? WHERE id = ? AND user_id = ?", [L, now, id, S]);
    if ((r.changes ?? 0) === 1) moved.bindings.push(id);
    else skipped.push({ kind: "binding", id, reason: "the binding changed while undoing: left as it is" });
  }
  for (const id of p.grantMoves) {
    const r = await c.run("UPDATE agent_grants SET subject_user_id = ? WHERE id = ? AND subject_user_id = ?", [L, id, S]);
    if ((r.changes ?? 0) === 1) moved.grants.push(id);
    else skipped.push({ kind: "grant", id, reason: "the grant changed while undoing: left as it is" });
  }
  for (const a of p.aliasRepoints) {
    const r = await c.run("UPDATE user_aliases SET user_id = ? WHERE old_id = ? AND user_id = ?", [a.from, a.old_id, a.to]);
    if ((r.changes ?? 0) === 1) moved.aliases.push(a.old_id);
    else skipped.push({ kind: "alias", id: a.old_id, reason: "the alias changed while undoing: left as it is" });
  }
  for (const id of p.aliasRemoves) {
    const r = await c.run("DELETE FROM user_aliases WHERE old_id = ? AND user_id = ?", [id, S]);
    if ((r.changes ?? 0) === 1) moved.aliases.push(id);
  }
  for (const s of p.stateRestores) {
    // Only a binding that went back, still verified with the recorded verified_at. Never lowers anything else.
    const back = moved.bindings.includes(s.id);
    const r = back
      ? await c.run("UPDATE bindings SET state = ?, verified_at = NULL, updated_at = ? WHERE id = ? AND state = 'verified' AND verified_at = ?", [s.to_state, now, s.id, s.verified_at])
      : { changes: 0 };
    if ((r.changes ?? 0) === 1) moved.restored.push(s.id);
    else skipped.push({ kind: "state", id: s.id, reason: "the binding changed while undoing: left as it is" });
  }
  if (p.unlink) {
    const r = await c.run("DELETE FROM slack_identities WHERE team_id = ? AND slack_user_id = ? AND account_id = ?", [p.unlink.teamId, p.unlink.slackUserId, p.unlink.accountId]);
    if ((r.changes ?? 0) === 1) moved.unlinked = true;
    else skipped.push({ kind: "link", id: mv.proof_binding_ids.slack ?? "", reason: "already unlinked after the merge: it stays unlinked" });
  }
  if (p.veto) {
    await c.run(
      `INSERT INTO merge_vetoes (id, key_a, key_b, created_by, created_at, merge_id) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (key_a, key_b) DO NOTHING`,
      [randomUUID(), p.veto[0], p.veto[1], i.actor, now, merge.id],
    );
  }

  const done = await c.run("UPDATE user_merges SET state = 'undone', undone_at = ?, undone_by = ? WHERE id = ? AND state = 'applied'", [now, i.actor, merge.id]);
  if ((done.changes ?? 0) !== 1) throw new Error("merge was undone concurrently");

  const events: DomainEvent[] = [
    {
      action: "user.merge_undone", mergeId: merge.id, survivorId: S, loserId: L, actor: i.actor, reason: i.reason,
      bindingIds: moved.bindings, grantIds: moved.grants, aliasIds: moved.aliases, restoredBindingIds: moved.restored, unlinked: moved.unlinked, skipped,
    },
  ];
  return { status: "undone", merge: (await getMerge(merge.id, c))!, moved, skipped, events };
}
