/**
 * Panel audit records (design §Audit records).
 *
 * One JSON object per line on stdout — no pretty-printing, so log pipelines can
 * split on newlines. Because the panel keeps no database, this is the only
 * record of operator actions.
 *
 * Never pass tokens, cookie values, the authorization code, the client secret,
 * or chat message content into `detail`.
 */
import type { PanelRole } from "./roles";

export interface AuditRecord {
  /** Dotted action name, e.g. "auth.login", "control.reset", "force-release". */
  action: string;
  operator: string;
  role?: PanelRole | null;
  session?: string;
  outcome?: "ok" | "denied" | "error";
  detail?: Record<string, unknown>;
}

export function audit(rec: AuditRecord, sink: (line: string) => void = console.log): void {
  const detail = rec.detail
    ? Object.fromEntries(Object.entries(rec.detail).filter(([, v]) => v !== undefined))
    : undefined;
  sink(
    JSON.stringify({
      ts: new Date().toISOString(),
      evt: "panel.audit",
      action: rec.action,
      operator: rec.operator,
      ...(rec.role !== undefined ? { role: rec.role } : {}),
      ...(rec.session ? { session: rec.session } : {}),
      outcome: rec.outcome ?? "ok",
      ...(detail && Object.keys(detail).length ? { detail } : {}),
    }),
  );
}
