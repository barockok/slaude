import { emitAudit, type EmitInput } from "./emit";

/**
 * Event builders for state changes made from more than one surface (slash
 * command, agent tool, panel), so every surface records the same shape.
 * All are fire-and-forget.
 */

export interface ThreadCtx {
  persona?: string | null;
  sessionId?: string | null;
  channelId?: string | null;
  threadTs?: string | null;
}

/** one_on_one.locked | one_on_one.unlocked. `userId` is the Slack user who
 *  acted; a panel unlock passes `operator` instead. */
export function auditOneOnOne(
  action: "one_on_one.locked" | "one_on_one.unlocked",
  a: ThreadCtx & {
    userId?: string;
    operator?: string;
    lockedUser?: string | null;
    via: "slash" | "agent_tool" | "panel" | "env";
    mode?: "open" | "relock";
  },
): void {
  const thread = `${a.channelId ?? "?"}:${a.threadTs ?? "?"}`;
  emitAudit({
    persona: a.persona,
    actorKind: a.operator ? "operator" : "slack_user",
    actorId: a.operator ?? a.userId ?? "unknown",
    action,
    targetKind: "thread",
    targetId: thread,
    sessionId: a.sessionId,
    channelId: a.channelId,
    threadTs: a.threadTs,
    summary: `1on1 ${action === "one_on_one.locked" ? "locked" : "released"}${a.lockedUser ? ` (owner ${a.lockedUser})` : ""}`,
    details: { via: a.via, ...(a.lockedUser ? { lockedUser: a.lockedUser } : {}), ...(a.mode ? { mode: a.mode } : {}) },
  });
}

/** ignore.set | ignore.cleared, for a user or a thread. */
export function auditIgnore(
  action: "ignore.set" | "ignore.cleared",
  a: ThreadCtx & {
    by: string;
    targetType: "user" | "thread";
    targetUser?: string;
    expiresAt?: number;
    reason?: string;
    via: "slash" | "agent_tool";
  },
): void {
  const targetId = a.targetType === "user" ? (a.targetUser ?? "unknown") : `${a.channelId ?? "?"}:${a.threadTs ?? "?"}`;
  emitAudit({
    persona: a.persona,
    actorKind: "slack_user",
    actorId: a.by,
    action,
    targetKind: a.targetType,
    targetId,
    sessionId: a.sessionId,
    channelId: a.channelId,
    threadTs: a.threadTs,
    summary: `${action === "ignore.set" ? "ignoring" : "stopped ignoring"} ${a.targetType} ${targetId}`,
    details: {
      via: a.via,
      ...(action === "ignore.set" ? { expiresAt: a.expiresAt ?? null } : {}),
      ...(a.reason ? { reason: a.reason } : {}),
    },
  });
}

export type SoulOverrideArgs = ThreadCtx & {
  userId?: string;
  operator?: string;
  tenantId?: string;
  /** The overridden field (a soul field name, or "all" for a full clear). */
  field: string | null;
  op?: string;
  value?: unknown;
  via: "slash" | "agent_tool" | "panel";
  details?: Record<string, unknown>;
};

/** soul.override.set | soul.override.cleared, from Slack /soul, the agent's
 *  soul_override tool, or the panel. `operator` marks a panel actor. */
export function auditSoulOverride(action: "soul.override.set" | "soul.override.cleared", a: SoulOverrideArgs): void {
  emitAudit(soulOverrideInput(action, a));
}

/** The event auditSoulOverride writes. Pure: the panel builds through it too. */
export function soulOverrideInput(
  action: "soul.override.set" | "soul.override.cleared",
  a: SoulOverrideArgs,
): EmitInput {
  return {
    ...(a.tenantId ? { tenantId: a.tenantId } : {}),
    persona: a.persona,
    actorKind: a.operator ? "operator" : "slack_user",
    actorId: a.operator ?? a.userId ?? "unknown",
    action,
    targetKind: "soul_field",
    targetId: a.field,
    sessionId: a.sessionId,
    channelId: a.channelId,
    threadTs: a.threadTs,
    summary:
      action === "soul.override.set"
        ? `soul override ${a.field ?? "?"}${a.op ? ` ${a.op}` : ""}${typeof a.value === "string" ? ` ${a.value}` : ""}`
        : `soul overrides cleared (${a.field ?? "?"})`,
    details: {
      ...(a.field ? { field: a.field } : {}),
      ...(a.op ? { op: a.op } : {}),
      ...(a.value !== undefined ? { value: a.value } : {}),
      via: a.via,
      ...(a.details ?? {}),
    },
  };
}

/**
 * skill.retired | skill.restored, from every path that moves a skill: the
 * weekly skill review (actor `agent`), a manager's Restore button in Slack
 * (`slack_user`) and the console (`operator`). Each path records once.
 */
export function auditSkill(
  action: "skill.retired" | "skill.restored",
  a: {
    persona: string;
    actorKind: "agent" | "slack_user" | "operator";
    actorId: string;
    slug: string;
    retiredId: string;
    reason?: string;
    via: "skill_review" | "slack" | "panel";
    operatorRole?: string;
  },
): void {
  emitAudit({
    tenantId: "default",
    persona: a.persona,
    actorKind: a.actorKind,
    actorId: a.actorId,
    action,
    targetKind: "skill",
    targetId: a.slug,
    summary: `${action === "skill.retired" ? "retired" : "restored"} skill ${a.slug}`,
    details: {
      skill: a.slug,
      retiredId: a.retiredId,
      persona: a.persona,
      via: a.via,
      ...(a.reason ? { reason: a.reason } : {}),
      ...(a.operatorRole ? { operatorRole: a.operatorRole } : {}),
    },
  });
}
