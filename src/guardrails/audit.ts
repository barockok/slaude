/**
 * Audit rows for owner guardrails (design section 5).
 *
 *   guardrail.tool.denied | guardrail.tool.audited
 *   guardrail.inbound.denied | guardrail.inbound.audited
 *   guardrail.guidance.delivered       (an on-match body handed to the model)
 *   guardrail.created | updated | deleted
 *   guardrail.node.unsupported | guardrail.integrity.failed
 *
 * Target: `guardrail <slug>#<rule id>`. Details name the agent, channel, tool
 * and rule, never the tool input or the message text: every firing in this
 * release is a pattern match, and a row whose pattern matched never stores the
 * text it matched. Summaries and details still go through the audit writer's
 * secret masking.
 */
import { emitAudit } from "../audit/emit";
import type { RuleHit } from "./match";

export interface FiringContext {
  tenantId?: string;
  persona: string;
  sessionId?: string | null;
  channelId?: string | null;
  threadTs?: string | null;
  /** Whose turn it was (the requester), when known. */
  userId?: string | null;
  /** Where the session runs: interactive, wake, remote, background. */
  kind?: string;
}

/** One firing, in a shape a node can send to its gateway unchanged. */
export interface FiringEvent {
  on: "tool" | "inbound";
  slug: string;
  ruleId: string;
  action: "deny" | "approve" | "audit";
  /** The action applied: a tool approve is enforced as a deny until approval cards exist. */
  applied: "deny" | "audit";
  deciding: boolean;
  toolName?: string;
}

export function firingAction(e: Pick<FiringEvent, "on" | "applied">): string {
  return `guardrail.${e.on}.${e.applied === "deny" ? "denied" : "audited"}`;
}

/** The firing events of one decision: every hit, the deciding one marked. */
export function firingEvents(on: "tool" | "inbound", hits: RuleHit[], deciding: RuleHit | null, toolName?: string): FiringEvent[] {
  return hits.map((h) => {
    const action = h.rule.action as FiringEvent["action"];
    return {
      on, slug: h.slug, ruleId: h.rule.id, action, applied: action === "audit" ? "audit" : "deny", deciding: h === deciding,
      ...(toolName ? { toolName } : {}),
    };
  });
}

export function auditFiring(e: FiringEvent, ctx: FiringContext): void {
  emitAudit({
    tenantId: ctx.tenantId,
    persona: ctx.persona,
    actorKind: ctx.userId ? "slack_user" : "agent",
    actorId: ctx.userId ?? ctx.persona,
    action: firingAction(e),
    targetKind: "guardrail",
    targetId: `${e.slug}#${e.ruleId}`,
    decision: e.applied === "deny" ? "deny" : "allow",
    sessionId: ctx.sessionId ?? null,
    channelId: ctx.channelId ?? null,
    threadTs: ctx.threadTs ?? null,
    summary: e.on === "tool" ? `guardrail ${e.slug}#${e.ruleId} ${e.applied === "deny" ? "denied" : "audited"} ${e.toolName ?? "a tool"}` : `guardrail ${e.slug}#${e.ruleId} ${e.applied === "deny" ? "denied" : "audited"} an inbound message`,
    details: {
      agent: ctx.persona,
      rule: e.ruleId,
      action: e.action,
      ...(e.action === "approve" ? { enforcedAs: "deny" } : {}),
      deciding: e.deciding,
      ...(e.toolName ? { tool: e.toolName } : {}),
      ...(ctx.channelId ? { channel: ctx.channelId } : {}),
      ...(ctx.kind ? { session: ctx.kind } : {}),
    },
  });
}

export function auditDelivery(slugs: string[], ctx: FiringContext & { via: "tool" | "inbound"; toolName?: string }): void {
  for (const slug of slugs) {
    emitAudit({
      tenantId: ctx.tenantId,
      persona: ctx.persona,
      actorKind: "agent",
      actorId: ctx.persona,
      action: "guardrail.guidance.delivered",
      targetKind: "guardrail",
      targetId: slug,
      sessionId: ctx.sessionId ?? null,
      channelId: ctx.channelId ?? null,
      threadTs: ctx.threadTs ?? null,
      summary: `guardrail ${slug} Guidance delivered (${ctx.via} trigger)`,
      details: { agent: ctx.persona, via: ctx.via, ...(ctx.toolName ? { tool: ctx.toolName } : {}), ...(ctx.kind ? { session: ctx.kind } : {}) },
    });
  }
}

/** guardrail.created | updated | deleted, one row per slug changed. */
export function auditChange(
  r: { created: string[]; updated: string[]; removed: string[]; enabledChanges?: Array<{ slug: string; enabled: boolean }> },
  ctx: { tenantId?: string; actorKind: "operator" | "system"; actorId: string; via: "cli" | "deploy" | "console"; revision?: string },
): void {
  const row = (action: string, slug: string, details: Record<string, unknown> = {}) =>
    emitAudit({
      tenantId: ctx.tenantId,
      consoleWide: true,
      actorKind: ctx.actorKind,
      actorId: ctx.actorId,
      action,
      targetKind: "guardrail",
      targetId: slug,
      summary: `guardrail ${slug} ${action.split(".")[1]} (${ctx.via})`,
      details: { via: ctx.via, ...(ctx.revision ? { revision: ctx.revision } : {}), ...details },
    });
  for (const s of r.created) row("guardrail.created", s);
  for (const s of r.updated) row("guardrail.updated", s);
  for (const s of r.removed) row("guardrail.deleted", s);
  for (const t of r.enabledChanges ?? []) row("guardrail.updated", t.slug, { enabled: t.enabled });
}
