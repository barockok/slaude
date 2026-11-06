import * as Sessions from "../db/sessions";
import type { PendingGate } from "../db/pending-gates";
import { audit, type AuditDeps, type AuditInput } from "./index";

/**
 * Fire-and-forget front door for decision points. `audit()` already never
 * throws; this adds two things the call sites need:
 *
 *  - persona: when the caller does not know it (the Slack gates are shared by
 *    every persona on a gateway), it is read from the session row; anything
 *    unknown is recorded as "default".
 *  - in-flight tracking, so tests (and a graceful shutdown) can wait for the
 *    writes with `flushAudits()` without the decision path ever awaiting them.
 */
export type EmitInput = Omit<AuditInput, "persona"> & { persona?: string | null };

const inflight = new Set<Promise<void>>();

export function emitAudit(input: EmitInput, deps?: AuditDeps): void {
  const p: Promise<void> = (async () => {
    let persona = input.persona;
    if (!persona && input.sessionId) {
      try {
        persona = (await Sessions.findById(input.sessionId))?.persona_id ?? null;
      } catch {
        persona = null;
      }
    }
    await audit({ ...input, persona: persona || "default" }, deps);
  })().catch(() => {});
  inflight.add(p);
  void p.finally(() => inflight.delete(p));
}

/** Resolve once every audit write started so far has settled. */
export async function flushAudits(): Promise<void> {
  while (inflight.size) await Promise.all([...inflight]);
}

/** pending_gates kind → the audit action segment. */
export function gateActionKind(kind: string): string {
  return kind === "perm" ? "permission" : kind;
}

/** Target of a gate row: the tool for a permission prompt, the scope or
 *  category for an approval, the server for an /mcp connect card. */
export function gateTarget(row: Pick<PendingGate, "kind" | "id" | "payload">): { targetKind: string; targetId: string } {
  const p = row.payload ?? {};
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  if (row.kind === "perm") return { targetKind: "tool", targetId: str(p.toolName) ?? "unknown" };
  if (row.kind === "approval") return { targetKind: "approval", targetId: str(p.scope) ?? str(p.category) ?? "plan" };
  return { targetKind: "mcp_server", targetId: str(p.serverName) ?? row.id };
}

/**
 * Audit one settled gate row: target, session, channel, thread and persona
 * come from the row, so every gate writer records the same shape.
 * `verb` is the last action segment: decided | refused | expired | cancelled.
 */
export function auditGateRow(
  row: Pick<PendingGate, "kind" | "id" | "payload" | "sessionId">,
  ev: {
    verb: "decided" | "refused" | "expired" | "cancelled";
    actorKind: EmitInput["actorKind"];
    actorId: string;
    decision: NonNullable<EmitInput["decision"]>;
    summary: string;
    details?: Record<string, unknown>;
  },
): void {
  const p = row.payload ?? {};
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  emitAudit({
    actorKind: ev.actorKind,
    actorId: ev.actorId,
    action: `gate.${gateActionKind(row.kind)}.${ev.verb}`,
    ...gateTarget(row),
    decision: ev.decision,
    persona: str(p.personaName),
    sessionId: row.sessionId,
    channelId: str(p.channel) ?? str(p.channelId),
    threadTs: str(p.threadTs),
    summary: ev.summary,
    details: {
      gateId: row.id,
      ...(row.kind === "approval" ? { category: p.category ?? null } : {}),
      ...(ev.details ?? {}),
    },
  });
}

/**
 * One `gate.<kind>.expired` per row a sweep expired. Exactly-once by
 * construction: a row reaches 'expired' through one guarded UPDATE (the sweep
 * here, or the approval gate's in-process auto-deny timer, which audits its
 * own win), so the owner of an expiry is whoever won that UPDATE and nothing
 * is counted twice. Callers pass the rows sweepExpired returned; src/db stays
 * free of audit imports.
 */
export function auditExpiredGates(rows: PendingGate[]): void {
  for (const r of rows) {
    auditGateRow(r, {
      verb: "expired",
      actorKind: "system",
      actorId: "system",
      decision: "expired",
      summary: `${r.kind} gate expired before a decision`,
    });
  }
}
