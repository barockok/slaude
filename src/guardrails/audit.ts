/**
 * Audit rows for owner guardrails (design section 5).
 *
 *   guardrail.tool.denied | approved | refused | audited
 *   guardrail.reply.denied | held | redacted | audited
 *   guardrail.inbound.denied | guardrail.inbound.audited
 *   guardrail.guidance.delivered       (an on-match body handed to the model)
 *   guardrail.created | updated | deleted | override.set | override.cleared
 *   guardrail.tested                   (the console Test box; never the text tested)
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

/**
 * What was done about one firing:
 *   deny      a deny rule refused it (tool, reply, inbound);
 *   approved  an approve rule held it and an approver let it go (tool);
 *   refused   an approve rule held it and it was not approved: denied,
 *             timed out, or nobody could be asked (a wake, a background pass);
 *   held      an approve rule held a reply for an approver (the decision is
 *             the approval card's own audit row);
 *   redacted  a redact rule replaced what it matched (reply);
 *   audit     recorded only.
 */
export type FiringApplied = "deny" | "approved" | "refused" | "held" | "redacted" | "audit";

/** One firing, in a shape a node can send to its gateway unchanged. */
export interface FiringEvent {
  on: "tool" | "inbound" | "reply";
  slug: string;
  ruleId: string;
  action: "deny" | "approve" | "redact" | "audit";
  applied: FiringApplied;
  deciding: boolean;
  toolName?: string;
  /** Where a reply was going (reply, edit, proactive_post, ...). */
  kind?: string;
}

const PAST: Record<FiringApplied, string> = { deny: "denied", approved: "approved", refused: "refused", held: "held", redacted: "redacted", audit: "audited" };

export function firingAction(e: Pick<FiringEvent, "on" | "applied">): string {
  return `guardrail.${e.on}.${PAST[e.applied]}`;
}

/** What a rule of `action` did when nothing more specific is known: a deny denies, an approve with no card is refused. */
export function defaultApplied(action: FiringEvent["action"]): FiringApplied {
  return action === "audit" ? "audit" : action === "redact" ? "redacted" : action === "approve" ? "refused" : "deny";
}

/**
 * The firing events of one decision: every hit, the deciding one marked.
 * `decided` is what happened to the event (an approve's outcome, a held
 * reply); it applies to every hit with the deciding rule's action. Other hits
 * keep their own default (an audit rule is audited, a redact rule redacted).
 */
export function firingEvents(
  on: FiringEvent["on"],
  hits: RuleHit[],
  deciding: RuleHit | null,
  toolName?: string,
  decided?: FiringApplied,
  kind?: string,
): FiringEvent[] {
  return hits.map((h) => {
    const action = h.rule.action as FiringEvent["action"];
    const applied = decided && deciding && action === deciding.rule.action ? decided : defaultApplied(action);
    return {
      on, slug: h.slug, ruleId: h.rule.id, action, applied, deciding: h === deciding,
      ...(toolName ? { toolName } : {}),
      ...(kind ? { kind } : {}),
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
    decision: e.applied === "deny" || e.applied === "refused" ? "deny" : "allow",
    sessionId: ctx.sessionId ?? null,
    channelId: ctx.channelId ?? null,
    threadTs: ctx.threadTs ?? null,
    summary: `guardrail ${e.slug}#${e.ruleId} ${PAST[e.applied]} ${e.on === "tool" ? (e.toolName ?? "a tool") : e.on === "reply" ? `a ${e.kind ?? "reply"}` : "an inbound message"}`,
    details: {
      agent: ctx.persona,
      rule: e.ruleId,
      action: e.action,
      deciding: e.deciding,
      ...(e.kind ? { kind: e.kind } : {}),
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

/** guardrail.created | updated | deleted | override.set | override.cleared, one row per slug changed (never the text). */
export function auditChange(
  r: { created: string[]; updated: string[]; removed: string[]; enabledChanges?: Array<{ slug: string; enabled: boolean }>; overrideSet?: string[]; overrideCleared?: string[] },
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
      summary: `guardrail ${slug} ${action.slice("guardrail.".length).replace(".", " ")} (${ctx.via})`,
      details: { via: ctx.via, ...(ctx.revision ? { revision: ctx.revision } : {}), ...details },
    });
  for (const s of r.created) row("guardrail.created", s);
  for (const s of r.updated) row("guardrail.updated", s);
  for (const s of r.removed) row("guardrail.deleted", s);
  for (const t of r.enabledChanges ?? []) row("guardrail.updated", t.slug, { enabled: t.enabled });
  for (const s of r.overrideSet ?? []) row("guardrail.override.set", s);
  for (const s of r.overrideCleared ?? []) row("guardrail.override.cleared", s);
}
