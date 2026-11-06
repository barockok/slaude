import { randomBytes } from "node:crypto";
import * as AuditEvents from "../db/audit-events";
import { m } from "../metrics";
import { redactSummary, redactValue } from "./redact";

/**
 * The one audit writer. Two sinks: the audit_events table (durable, queried by
 * the console) and one JSON line on stdout (same shape family as the panel's
 * `panel.audit` line: `ts`, `evt`, `action`, `session`, `detail`).
 *
 * Never throws and never blocks a decision: a failed sink is logged and counted
 * in slaude_audit_write_failures_total. The stdout line is written first so it
 * survives a database failure.
 *
 * Bounded: the summary is capped at 500 characters (redact.ts) and serialized
 * details at 16 KB; larger details are replaced by a marker with a 1 KB preview.
 */
export type ActorKind = "slack_user" | "operator" | "agent" | "system";
export type AuditDecision = "allow" | "always" | "deny" | "expired" | "cancelled" | "refused";

export interface AuditInput {
  tenantId?: string;
  persona?: string | null;
  actorKind: ActorKind;
  actorId: string;
  /** Dotted verb, e.g. "gate.permission.decided". */
  action: string;
  targetKind?: string | null;
  targetId?: string | null;
  decision?: AuditDecision | null;
  sessionId?: string | null;
  channelId?: string | null;
  threadTs?: string | null;
  summary?: string;
  details?: Record<string, unknown>;
}

export interface AuditDeps {
  sink?: (line: string) => void;
  insert?: (ev: AuditEvents.AuditEvent, detailsJson: string) => Promise<void>;
  now?: () => number;
}

export const MAX_DETAILS_BYTES = 16 * 1024;
const PREVIEW_CHARS = 1024;
const UNSERIALIZABLE = { unserializable: true };

/** Zero-padded epoch ms + random suffix: lexical order is time order. */
export function newAuditId(at: number): string {
  return `${AuditEvents.timeKey(at)}-${randomBytes(6).toString("hex")}`;
}

export async function audit(input: AuditInput, deps: AuditDeps = {}): Promise<void> {
  const sink = deps.sink ?? ((line: string) => console.log(line));
  const insert = deps.insert ?? AuditEvents.insert;
  let ev: AuditEvents.AuditEvent;
  let detailsJson: string;
  try {
    const at = (deps.now ?? Date.now)();
    let details: Record<string, unknown>;
    // Redact and serialize once. Details that cannot be read or serialized
    // degrade to a marker: the event is still written, as one failure.
    try {
      details = redactValue(input.details ?? {}) as Record<string, unknown>;
      detailsJson = JSON.stringify(details);
      const bytes = Buffer.byteLength(detailsJson);
      if (bytes > MAX_DETAILS_BYTES) {
        details = { truncated: true, bytes, preview: detailsJson.slice(0, PREVIEW_CHARS) };
        detailsJson = JSON.stringify(details);
      }
    } catch (err) {
      fail(input.action, err);
      details = { ...UNSERIALIZABLE };
      detailsJson = JSON.stringify(UNSERIALIZABLE);
    }
    ev = {
      id: newAuditId(at),
      tenantId: input.tenantId,
      persona: input.persona ?? null,
      at,
      actorKind: input.actorKind,
      actorId: input.actorId,
      action: input.action,
      targetKind: input.targetKind ?? null,
      targetId: input.targetId ?? null,
      decision: input.decision ?? null,
      sessionId: input.sessionId ?? null,
      channelId: input.channelId ?? null,
      threadTs: input.threadTs ?? null,
      summary: typeof input.summary === "string" ? redactSummary(input.summary) : "",
      details,
    };
  } catch (err) {
    fail(input.action, err);
    return;
  }
  try {
    sink(stdoutLine(ev, detailsJson));
  } catch (err) {
    fail(ev.action, err);
  }
  try {
    await insert(ev, detailsJson);
  } catch (err) {
    fail(ev.action, err);
  }
}

function stdoutLine(ev: AuditEvents.AuditEvent, detailsJson: string): string {
  const head = JSON.stringify({
    ts: new Date(ev.at).toISOString(),
    evt: "audit",
    id: ev.id,
    action: ev.action,
    actor_kind: ev.actorKind,
    actor_id: ev.actorId,
    ...(ev.tenantId ? { tenant: ev.tenantId } : {}),
    ...(ev.persona ? { persona: ev.persona } : {}),
    ...(ev.targetKind ? { target_kind: ev.targetKind } : {}),
    ...(ev.targetId ? { target_id: ev.targetId } : {}),
    ...(ev.decision ? { decision: ev.decision } : {}),
    ...(ev.sessionId ? { session: ev.sessionId } : {}),
    ...(ev.channelId ? { channel: ev.channelId } : {}),
    ...(ev.threadTs ? { thread_ts: ev.threadTs } : {}),
    ...(ev.summary ? { summary: ev.summary } : {}),
  });
  // Splice the already-serialized details in rather than serializing twice.
  return Object.keys(ev.details).length ? `${head.slice(0, -1)},"detail":${detailsJson}}` : head;
}

function fail(action: string, err: unknown): void {
  m.auditWriteFailuresTotal.inc();
  console.warn(`[audit] action=${action}: write failed: ${(err as Error)?.message ?? String(err)}`);
}
