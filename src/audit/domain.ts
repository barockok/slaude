import { audit, type AuditDeps } from "./index";
import type { DomainEvent } from "../db/domain";
import { invalidateActors } from "../refs/actor";
import { queueMergeNotice } from "../domain/merge-notice";

export interface DomainAuditOptions {
  actorId?: string;
  persona?: string | null;
  tenantId?: string;
  /** Batch callers (backfill, sync) pass true and write one summary event of their own. */
  suppress?: boolean;
}

/**
 * Write the audit events a domain write returned. Call it after the
 * transaction commits. Details carry ids and service names only: never a
 * binding value (an email address, a Slack id), so nothing here needs
 * redaction beyond what `audit` already does.
 */
export async function emitDomainEvents(events: readonly DomainEvent[], opts: DomainAuditOptions = {}, deps?: AuditDeps): Promise<void> {
  if (opts.suppress) {
    // A batch caller writes its own summary, but a merge still drops cached actors and queues its notice.
    for (const e of events) {
      if (e.action === "user.merge_undone") invalidateActors();
      if (e.action === "user.merged") {
        invalidateActors();
        queueMergeNotice(e.mergeId);
      }
    }
    return;
  }
  for (const e of events) {
    await audit(
      {
        tenantId: opts.tenantId,
        persona: opts.persona ?? null,
        actorKind: (e.action === "user.merged" && e.kind === "console") || e.action === "user.merge_undone" ? "operator" : "system",
        actorId: e.action === "user.merged" || e.action === "user.merge_undone" ? e.actor : opts.actorId ?? "system",
        action: e.action,
        targetKind: e.action === "boundary.created" ? "boundary" : e.action === "binding.created" ? "binding" : "user",
        targetId:
          e.action === "boundary.created" ? e.boundaryId : e.action === "binding.created" ? e.bindingId : e.action === "user.merged" || e.action === "user.merge_undone" ? e.survivorId : e.userId,
        summary: summary(e),
        details: details(e),
      },
      deps,
    );
    // A merge or its undo changes who a Slack id is: drop cached actors (and queue the notice for a merge), only after the commit that this call follows.
    if (e.action === "user.merge_undone") invalidateActors();
    if (e.action === "user.merged") {
      invalidateActors();
      queueMergeNotice(e.mergeId);
    }
  }
}

function summary(e: DomainEvent): string {
  switch (e.action) {
    case "user.created": return "user record created";
    case "binding.created": return `binding created (${e.service}, ${e.state})`;
    case "boundary.created": return `boundary created (${e.service}, ${e.state})`;
    case "user.adopted": return `user adopted ${e.bindingIds.length} binding(s) from a merged record`;
    case "user.merge_undone": return `merge undone: ${e.bindingIds.length} binding(s), ${e.grantIds.length} stored grant(s) returned, ${e.skipped.length} left as they are`;
    case "user.merged": return `user records merged (${e.kind}): ${e.bindingIds.length} binding(s), ${e.grantIds.length} stored grant(s) moved, ${e.activated} grant(s) became active`;
  }
}

function details(e: DomainEvent): Record<string, unknown> {
  switch (e.action) {
    case "user.created": return { user_id: e.userId };
    case "binding.created": return { user_id: e.userId, binding_id: e.bindingId, service: e.service, state: e.state };
    case "boundary.created": return { boundary_id: e.boundaryId, service: e.service, state: e.state };
    case "user.adopted": return { user_id: e.userId, from_user_id: e.fromUserId, binding_ids: e.bindingIds };
    case "user.merge_undone":
      return {
        merge_id: e.mergeId, survivor_id: e.survivorId, loser_id: e.loserId, reason: e.reason,
        binding_ids: e.bindingIds, grant_ids: e.grantIds, alias_ids: e.aliasIds, restored_binding_ids: e.restoredBindingIds,
        link_removed: e.unlinked, skipped: e.skipped,
      };
    case "user.merged":
      return {
        merge_id: e.mergeId, survivor_id: e.survivorId, loser_id: e.loserId, kind: e.kind,
        binding_ids: e.bindingIds, grant_ids: e.grantIds, raised_binding_ids: e.raisedBindingIds,
        activated: e.activated, inactive_privileged: e.inactivePrivileged,
      };
  }
}
