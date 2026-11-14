import { audit, type AuditDeps } from "./index";
import type { DomainEvent } from "../db/domain";

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
  if (opts.suppress) return;
  for (const e of events) {
    await audit(
      {
        tenantId: opts.tenantId,
        persona: opts.persona ?? null,
        actorKind: "system",
        actorId: opts.actorId ?? "system",
        action: e.action,
        targetKind: e.action === "boundary.created" ? "boundary" : e.action === "binding.created" ? "binding" : "user",
        targetId: e.action === "boundary.created" ? e.boundaryId : e.action === "binding.created" ? e.bindingId : e.userId,
        summary: summary(e),
        details: details(e),
      },
      deps,
    );
  }
}

function summary(e: DomainEvent): string {
  switch (e.action) {
    case "user.created": return "user record created";
    case "binding.created": return `binding created (${e.service}, ${e.state})`;
    case "boundary.created": return `boundary created (${e.service}, ${e.state})`;
    case "user.adopted": return `user adopted ${e.bindingIds.length} binding(s) from a merged record`;
  }
}

function details(e: DomainEvent): Record<string, unknown> {
  switch (e.action) {
    case "user.created": return { user_id: e.userId };
    case "binding.created": return { user_id: e.userId, binding_id: e.bindingId, service: e.service, state: e.state };
    case "boundary.created": return { boundary_id: e.boundaryId, service: e.service, state: e.state };
    case "user.adopted": return { user_id: e.userId, from_user_id: e.fromUserId, binding_ids: e.bindingIds };
  }
}
