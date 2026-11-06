/**
 * Panel audit records (design §Audit records), written through the one audit
 * writer (src/audit): a durable audit_events row plus one JSON line on stdout.
 * The writer owns the stdout line, so the panel and the rest of the runtime
 * cannot drift and an operator action prints once, not twice.
 *
 * The panel's own action names map onto the platform's dotted actions; the
 * original name is kept in details as `panelAction`.
 *
 * Never pass tokens, cookie values, the authorization code, the client secret,
 * or chat message content into `detail`.
 */
import { emitAudit } from "../../../audit/emit";
import type { AuditDeps, AuditInput } from "../../../audit";
import type { PanelRole } from "./roles";

export interface AuditRecord {
  /** Panel action name, e.g. "auth.login", "control.reset", "force-release". */
  action: string;
  operator: string;
  role?: PanelRole | null;
  session?: string;
  outcome?: "ok" | "denied" | "error";
  detail?: Record<string, unknown>;
}

const SESSION_ACTIONS = new Set(["chat", "lock", "release", "force-release"]);

/** Panel action → platform action, target and (for refusals) decision. Pure. */
export function panelAuditInput(rec: AuditRecord): AuditInput & { persona?: string | null } {
  const detail = rec.detail
    ? Object.fromEntries(Object.entries(rec.detail).filter(([, v]) => v !== undefined))
    : {};
  const outcome = rec.outcome ?? "ok";
  const persona = typeof detail.persona === "string" ? detail.persona : undefined;
  const tenantId = typeof detail.tenantId === "string" ? detail.tenantId : undefined;
  let action: string;
  let targetKind: string | null = null;
  let targetId: string | null = null;
  if (rec.action.startsWith("control.") || SESSION_ACTIONS.has(rec.action)) {
    action = "panel.session.control";
  } else if (rec.action === "persona.create") {
    action = "panel.persona.onboard";
  } else if (rec.action === "persona.override") {
    // The same change a manager makes with /soul, so the same action names.
    action = detail.op === "clear" ? "soul.override.cleared" : detail.op === "set" ? "soul.override.set" : "panel.persona.override";
    targetKind = "soul_field";
    targetId = typeof detail.field === "string" ? detail.field : null;
  } else if (rec.action === "reload") {
    action = "panel.config.reload";
  } else {
    action = `panel.${rec.action}`;
  }
  if (!targetKind) {
    if (rec.session) [targetKind, targetId] = ["session", rec.session];
    else if (persona) [targetKind, targetId] = ["persona", persona];
  }
  return {
    ...(tenantId ? { tenantId } : {}),
    persona,
    actorKind: "operator",
    actorId: rec.operator,
    action,
    targetKind,
    targetId,
    decision: outcome === "denied" ? "refused" : null,
    sessionId: rec.session ?? null,
    summary: `${rec.action}${outcome === "ok" ? "" : ` (${outcome})`}`,
    details: {
      panelAction: rec.action,
      ...(rec.role !== undefined ? { role: rec.role } : {}),
      outcome,
      ...detail,
    },
  };
}

/** Fire-and-forget; `sink` replaces the stdout line (tests). */
export function audit(rec: AuditRecord, sink?: (line: string) => void): void {
  const deps: AuditDeps | undefined = sink ? { sink } : undefined;
  emitAudit(panelAuditInput(rec), deps);
}
