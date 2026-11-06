import { emitAudit } from "./emit";

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
