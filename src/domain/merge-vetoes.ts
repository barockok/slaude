/**
 * Vetoes an undo left behind (slice C). A veto forbids a pair of identities from
 * joining again, by the engine and by `linkSlackIdentity`, until an operator
 * lifts it. It holds hashed keys only (src/domain/merge-keys.ts), so the console
 * shows who made it and from which merge, never what it names.
 */
import { db } from "../db/schema";
import { maskActor } from "../db/domain-read";
import { emitAudit } from "../audit/emit";
import type { MergeVetoItem } from "../gateway/panel/api-types";

export async function listVetoes(): Promise<MergeVetoItem[]> {
  const rows = await db.query<{ id: string; created_by: string; created_at: number; merge_id: string | null }>(
    "SELECT id, created_by, created_at, merge_id FROM merge_vetoes ORDER BY created_at DESC, id DESC LIMIT 200",
  );
  return rows.map((r) => ({ id: r.id, createdBy: maskActor(r.created_by) ?? "", createdAt: Number(r.created_at), mergeId: r.merge_id }));
}

export type LiftOutcome = { status: "lifted" } | { status: "not-found" };

/** Delete a veto. The reason is recorded in the audit event as the operator. */
export async function liftVeto(i: { id: string; operator: string; reason: string }): Promise<LiftOutcome> {
  const row = await db.one<{ merge_id: string | null }>("SELECT merge_id FROM merge_vetoes WHERE id = ?", [i.id]);
  if (!row) return { status: "not-found" };
  const r = await db.run("DELETE FROM merge_vetoes WHERE id = ?", [i.id]);
  if ((r.changes ?? 0) !== 1) return { status: "not-found" };
  emitAudit({
    actorKind: "operator", actorId: i.operator, persona: null, consoleWide: true,
    action: "merge.veto.lifted", targetKind: "merge_veto", targetId: i.id,
    summary: "merge veto lifted", details: { veto_id: i.id, merge_id: row.merge_id, reason: i.reason },
  });
  return { status: "lifted" };
}
