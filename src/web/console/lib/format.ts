import type { AuditEventView } from "../../../gateway/panel/api-types";
import { isConsoleWideAuditAction } from "../../../gateway/panel/console-wide";

/**
 * Display helpers for the console: audit actions, sessions and Slack subjects.
 * Time helpers live in shared/time.ts and are re-exported here.
 */

export { absoluteTime, expiryLabel, relativeTime, shortDate } from "../../shared/time";

const GATE_KIND: Record<string, string> = { permission: "Tool permission", approval: "Approval", mcp_connect: "Connection", connect: "Connection" };
const GATE_VERB: Record<string, string> = { decided: "decided", refused: "click refused", expired: "expired", cancelled: "cancelled" };

const ACTION_LABELS: Record<string, string> = {
  "grant.created": "Grant added",
  "grant.revoked": "Grant revoked",
  "control.stop": "Session stopped from console",
  "control.reset": "Session reset from console",
  "control.model": "Model changed from console",
  "control.mode": "Permission mode changed",
  "control.unlock-1on1": "1:1 lock released from console",
  "persona.create": "Agent created",
  "persona.override": "Agent setting overridden",
  "persona.sync": "Agents synced",
  "memory.page.viewed": "Private memory page viewed",
  "skill.version.viewed": "Agent skill version viewed",
  "skill.retired": "Skill retired",
  "skill.restored": "Skill restored",
  "proposal.decided": "Proposal decided",
  "one_on_one.locked": "1:1 started",
  "ignore.set": "Ignore list changed",
  "soul.override.set": "Soul override set",
  "auth.login": "Signed in to console",
  "auth.logout": "Signed out of console",
  "auth.denied": "Console sign-in denied",
  "one_on_one.unlocked": "1:1 ended",
  "ignore.cleared": "Ignore list cleared",
  "soul.override.cleared": "Soul override cleared",
  "panel.session.control": "Session controlled from console",
  "panel.persona.onboard": "Agent onboarded from console",
  "panel.persona.override": "Agent override refused",
  "panel.config.reload": "Agent config reloaded",
  "panel.auth.login": "Signed in to console",
  "panel.auth.logout": "Signed out of console",
  "panel.auth.denied": "Console sign-in denied",
  "panel.console.roles.read": "Console roles viewed",
};

/** A readable sentence-case label for a dotted audit action. */
export function actionLabel(action: string): string {
  const known = ACTION_LABELS[action];
  if (known) return known;
  const gate = /^gate\.([a-z_]+)\.([a-z_]+)$/.exec(action);
  if (gate && GATE_KIND[gate[1]!]) return `${GATE_KIND[gate[1]!]} ${GATE_VERB[gate[2]!] ?? gate[2]!}`;
  const words = action.split(/[._-]+/).filter(Boolean).join(" ");
  return words ? words[0]!.toUpperCase() + words.slice(1) : action;
}

/** Badge tone for an audit decision. */
export function decisionTone(decision: string): "success" | "danger" | "warning" | "neutral" {
  const d = decision.toLowerCase();
  if (/^(allow|always|approve|granted|ok|accept)/.test(d)) return "success";
  if (/^(deny|denied|reject|refused|blocked)/.test(d)) return "danger";
  if (/^(pending|timeout|timed_out|expired|cancelled)/.test(d)) return "warning";
  return "neutral";
}

export function decisionLabel(decision: string): string {
  const s = decision.replace(/[_-]+/g, " ");
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export const ACTOR_KIND_LABEL: Record<string, string> = {
  slack_user: "Slack user",
  operator: "Operator",
  agent: "Agent",
  system: "System",
};

const ROLE_LABEL: Record<string, string> = { superadmin: "Superadmin", operator: "Operator" };

/**
 * The actor's kind as the Actor column says it: an operator's console role
 * when the row records one (details.operatorRole, or details.role written by
 * the panel). A grant row's details.role is the granted role, not the
 * operator's, so only a console role name counts.
 */
export function actorKindLabel(e: Pick<AuditEventView, "actorKind" | "details">): string {
  if (e.actorKind === "operator") {
    const d = e.details ?? {};
    for (const v of [d.operatorRole, d.role]) if (typeof v === "string" && ROLE_LABEL[v]) return ROLE_LABEL[v]!;
  }
  return ACTOR_KIND_LABEL[e.actorKind] ?? e.actorKind;
}

/** Who did it, for display: an agent actor by the agent's name (the gateway's actorLabel), anyone else by their id. */
export function auditActorName(e: Pick<AuditEventView, "actorId" | "actorLabel">): string {
  return e.actorLabel || e.actorId;
}

/**
 * Who an audit row is about, for the Agent column: the agent, or null for a
 * console-wide event. Older rows recorded console sign-ins under the default
 * agent; those read as console-wide too.
 */
export function auditAgent(e: Pick<AuditEventView, "persona" | "action">): string | null {
  if (!e.persona) return null;
  if (e.persona === "default" && isConsoleWideAuditAction(e.action)) return null;
  return e.persona;
}

/** The Target column: `kind id`, with a channel's `#name` when the gateway resolved it. */
export function auditTarget(e: Pick<AuditEventView, "targetKind" | "targetId" | "targetLabel">): string | null {
  if (!e.targetId) return null;
  const id = e.targetLabel ?? e.targetId;
  return e.targetKind ? `${e.targetKind.replace(/_/g, " ")} ${id}` : id;
}

/** Build "/audit?persona=...&action=..." with only the set parameters. */
export function auditHref(params: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `/audit?${s}` : "/audit";
}

/** The audit page, filtered down to the clicked event's kind and context. */
export function auditLinkFor(e: AuditEventView): string {
  return auditHref({ persona: e.persona ?? undefined, action: e.action, session: e.sessionId ?? undefined });
}

/** "14:05:09" in the viewer's time zone. */
export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

/** "850 ms", "4.2 s", "3 min 05 s". */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} min ${String(s).padStart(2, "0")} s`;
}

const SESSION_STATUS: Record<string, { label: string; tone: "accent" | "neutral" | "danger" | "warning" | "success" }> = {
  running: { label: "Running", tone: "accent" },
  idle: { label: "Idle", tone: "neutral" },
  waiting: { label: "Waiting", tone: "warning" },
  error: { label: "Error", tone: "danger" },
  crashed: { label: "Crashed", tone: "danger" },
  stopped: { label: "Stopped", tone: "neutral" },
  done: { label: "Done", tone: "success" },
};

/** Label and badge tone for a session status; unknown values pass through. */
export function sessionStatus(status: string): { label: string; tone: "accent" | "neutral" | "danger" | "warning" | "success" } {
  return SESSION_STATUS[status] ?? { label: status ? status[0]!.toUpperCase() + status.slice(1) : "Unknown", tone: "neutral" };
}

export const PERMISSION_MODE_LABEL: Record<string, string> = {
  default: "Default (ask)",
  acceptEdits: "Accept edits",
  bypassPermissions: "Bypass permissions",
  plan: "Plan only",
  dontAsk: "Do not ask",
};

const SESSION_ACTIVITY: Record<string, { label: string; tone: "accent" | "neutral" | "danger" | "warning" | "success"; hint: string }> = {
  working: { label: "Working", tone: "accent", hint: "A turn is in flight" },
  warm: { label: "Warm", tone: "success", hint: "The agent process is up and waiting for the next message" },
  idle: { label: "Idle", tone: "neutral", hint: "Nothing is running; the next message starts the agent again" },
  error: { label: "Error", tone: "danger", hint: "The session failed and nothing is running" },
};

/** Label, tone and explanation for what a session is doing now (SessionActivity). */
export function sessionActivity(activity: string): { label: string; tone: "accent" | "neutral" | "danger" | "warning" | "success"; hint: string } {
  return SESSION_ACTIVITY[activity] ?? { ...sessionStatus(activity), hint: "" };
}

/** The session's page path. */
export const sessionPath = (id: string, tab?: string) =>
  `/sessions/${encodeURIComponent(id)}${tab && tab !== "timeline" ? `/${tab}` : ""}`;
