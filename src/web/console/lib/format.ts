import type { AuditEventView } from "../../../gateway/panel/api-types";

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

/** The session's page path. */
export const sessionPath = (id: string, tab?: string) =>
  `/sessions/${encodeURIComponent(id)}${tab && tab !== "timeline" ? `/${tab}` : ""}`;
