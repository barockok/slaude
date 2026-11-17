/**
 * Settling a merge proposal from the console (slice C, task 29).
 *
 * A proposal is a pair of records a human decides, written when the engine
 * refused an automatic merge (`proposeMerge`). Approving runs `mergeUsers` kind
 * `console` and keeps every refusal the engine has (D5): a record holding any
 * verified binding is still refused, as is a bot or agent, two different
 * verified emails on one record, and a vetoed pair. A verified-versus-verified
 * conflict is resolved by unlinking or deleting the losing account first (the
 * existing flows), then approving. The merge never raises a binding state.
 *
 * Typed confirmation. `approveProposal` first runs the merge inside a
 * transaction it rolls back and answers `confirm` with the whole outcome: which
 * record survives and which is merged away (masked labels), how many bindings
 * and stored grants move, the grants it would activate and the privileged ones
 * that stay inactive (`persona:role:entry`, no address and no Slack id). The
 * merge happens only when the same outcome comes back in `confirm`; an outcome
 * that differs from what would happen NOW (the world changed since the operator
 * looked, or the direction flipped) is refused with the current one. An empty
 * list is not a blind approval: the whole object must match.
 */
import * as Domain from "../db/domain";
import { db as globalDb, type DbClient } from "../db/schema";
import { emitDomainEvents } from "../audit/domain";
import { emitAudit } from "../audit/emit";
import { m } from "../metrics";
import { mergeUsers, type MergeRow, type RefusalReason } from "./merge";
import type { GrantDiff } from "./merge-reach";
import { recordLabel } from "../db/merge-read";

export interface ProposalRow {
  id: string;
  created_at: number;
  user_a: string;
  user_b: string;
  reason: "conflict" | "two-emails";
  state: "open" | "dismissed" | "merged";
  evidence: string;
  resolved_by: string | null;
  resolved_at: number | null;
}

/** `persona:role:entry`, sorted and unique: what the operator types back. */
export function activationLines(activated: GrantDiff["activated"]): string[] {
  return [...new Set(activated.map((a) => `${a.persona}:${a.role}:${a.entry}`))].sort();
}

/** What an approval would do, echoed back by the operator. Labels are masked; nothing here is an address or a Slack id. */
export interface ApprovalOutcome {
  survivor: string;
  loser: string;
  bindings: number;
  grants: number;
  activates: string[];
  inactivePrivileged: string[];
}
const sameOutcome = (a: ApprovalOutcome, b: ApprovalOutcome): boolean =>
  JSON.stringify([a.survivor, a.loser, a.bindings, a.grants, [...a.activates].sort(), [...a.inactivePrivileged].sort()]) ===
  JSON.stringify([b.survivor, b.loser, b.bindings, b.grants, [...b.activates].sort(), [...b.inactivePrivileged].sort()]);

export type ApproveOutcome =
  | { status: "not-found" }
  | { status: "not-open"; state: string }
  | { status: "stale"; reason: string }
  | { status: "refused"; reason: RefusalReason }
  | { status: "confirm"; outcome: ApprovalOutcome }
  | { status: "confirm-mismatch"; outcome: ApprovalOutcome }
  | { status: "merged"; merge: MergeRow };

/** Thrown inside the transaction to roll it back and carry the answer out. */
class Rollback extends Error {
  constructor(readonly out: ApproveOutcome) {
    super("rollback");
  }
}

export async function approveProposal(i: { id: string; operator: string; confirm?: ApprovalOutcome }): Promise<ApproveOutcome> {
  let result: ApproveOutcome;
  let events: Domain.DomainEvent[] = [];
  try {
    result = await globalDb.transaction(async (c: DbClient) => {
      const p = await c.one<ProposalRow>(`SELECT * FROM merge_proposals WHERE id = ?${c.dialect === "pg" ? " FOR UPDATE" : ""}`, [i.id]);
      if (!p) return { status: "not-found" } as const;
      if (p.state !== "open") return { status: "not-open", state: p.state } as const;
      const a = await Domain.resolveUserId(p.user_a, c);
      const b = await Domain.resolveUserId(p.user_b, c);
      if (!a || !b) return { status: "stale", reason: "a record of this proposal no longer exists" } as const;
      if (a === b) return { status: "stale", reason: "the two records are already one" } as const;

      const labels = new Map([[a, await recordLabel(a, c)], [b, await recordLabel(b, c)]]);
      const out = await mergeUsers({ survivorId: a, loserId: b, kind: "console", actor: i.operator, pickSurvivor: true, dryRun: true }, c);
      if (out.status === "refused") throw new Rollback({ status: "refused", reason: out.reason }); // drops any proposal the refusal wrote
      if (out.status === "noop") return { status: "stale", reason: "the two records are already one" } as const;
      const moved = out.merge.moved;
      const outcome: ApprovalOutcome = {
        survivor: labels.get(out.survivorId) ?? "record",
        loser: labels.get(out.loserId) ?? "record",
        bindings: moved.bindings.length,
        grants: moved.grants.length,
        activates: activationLines(moved.would_activate ?? moved.activated),
        inactivePrivileged: [...new Set((moved.would_inactive_privileged ?? moved.inactive_privileged).map((g) => `${g.persona}:${g.role}:${g.entry}`))].sort(),
      };
      if (i.confirm === undefined) throw new Rollback({ status: "confirm", outcome });
      if (!sameOutcome(i.confirm, outcome)) throw new Rollback({ status: "confirm-mismatch", outcome });
      const upd = await c.run(
        "UPDATE merge_proposals SET state = 'merged', resolved_by = ?, resolved_at = ? WHERE id = ? AND state = 'open'",
        [i.operator, Date.now(), p.id],
      );
      if ((upd.changes ?? 0) !== 1) throw new Rollback({ status: "not-open", state: "merged" });
      events = out.events;
      return { status: "merged", merge: out.merge } as const;
    }, { immediate: true });
  } catch (e) {
    if (e instanceof Rollback) return e.out;
    throw e;
  }
  if (result.status === "merged") {
    // The merge ran with `dryRun` so a preview is not counted; this one stands, so count it now.
    m.userMergesTotal.inc({ kind: "console", result: "merged" });
    await emitDomainEvents(events, { actorId: i.operator });
    emitAudit({
      actorKind: "operator",
      actorId: i.operator,
      persona: null,
      consoleWide: true,
      action: "merge.proposal.approved",
      targetKind: "merge_proposal",
      targetId: i.id,
      summary: "merge proposal approved",
      details: { proposal_id: i.id, merge_id: result.merge.id },
    });
  }
  return result;
}

export type DismissOutcome = { status: "dismissed" } | { status: "not-found" } | { status: "not-open"; state: string };

export async function dismissProposal(i: { id: string; operator: string }): Promise<DismissOutcome> {
  const out = await globalDb.transaction(async (c) => {
    const p = await c.one<ProposalRow>("SELECT * FROM merge_proposals WHERE id = ?", [i.id]);
    if (!p) return { status: "not-found" } as const;
    const r = await c.run("UPDATE merge_proposals SET state = 'dismissed', resolved_by = ?, resolved_at = ? WHERE id = ? AND state = 'open'", [i.operator, Date.now(), i.id]);
    if ((r.changes ?? 0) !== 1) return { status: "not-open", state: p.state } as const;
    return { status: "dismissed" } as const;
  });
  if (out.status === "dismissed") {
    emitAudit({
      actorKind: "operator",
      actorId: i.operator,
      persona: null,
      consoleWide: true,
      action: "merge.proposal.dismissed",
      targetKind: "merge_proposal",
      targetId: i.id,
      summary: "merge proposal dismissed",
      details: { proposal_id: i.id },
    });
  }
  return out;
}
