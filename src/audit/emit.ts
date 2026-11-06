import { db } from "../db/schema";
import type { PendingGate } from "../db/pending-gates";
import { audit, type AuditDeps, type AuditInput } from "./index";

/**
 * Fire-and-forget front door for decision points. `audit()` already never
 * throws; this adds two things the call sites need:
 *
 *  - persona: callers pass it when they know it (gate rows carry
 *    `personaName`); otherwise it is read from the session row (persona_id
 *    only); anything unknown is recorded as "default".
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
        persona = (await db.one<{ persona_id: string | null }>(`SELECT persona_id FROM sessions WHERE id = ?`, [input.sessionId]))?.persona_id ?? null;
      } catch {
        persona = null;
      }
    }
    await audit({ ...input, persona: persona || "default" }, deps);
  })().catch(() => {});
  inflight.add(p);
  void p.finally(() => inflight.delete(p));
}

/** Resolve once every audit write started so far has settled, or after
 *  `timeoutMs` (shutdown: a hung sink must not hold the exit). */
export async function flushAudits(opts: { timeoutMs?: number } = {}): Promise<void> {
  const drain = (async () => {
    while (inflight.size) await Promise.all([...inflight]);
  })();
  if (opts.timeoutMs === undefined) return drain;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((r) => {
    timer = setTimeout(r, opts.timeoutMs);
    timer.unref?.();
  });
  await Promise.race([drain, bound]);
  clearTimeout(timer);
}

/** A non-empty string, else null. */
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** pending_gates kind → the audit action segment. */
export function gateActionKind(kind: string): string {
  return kind === "perm" ? "permission" : kind;
}

/** Target of a gate row: the tool for a permission prompt, the scope or
 *  category for an approval, the server for an /mcp connect card. */
export function gateTarget(row: Pick<PendingGate, "kind" | "id" | "payload">): { targetKind: string; targetId: string } {
  const p = row.payload ?? {};
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
