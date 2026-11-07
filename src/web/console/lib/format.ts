import type { AuditEventView } from "../../../gateway/panel/api-types";

/**
 * Display helpers for the console: times, audit actions and Slack subjects.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 h ago", "2 d ago", then a short date. */
export function relativeTime(at: number, now: number = Date.now()): string {
  const d = now - at;
  if (d < 0) return relativeFuture(-d) ?? absoluteTime(at);
  if (d < MINUTE) return "just now";
  if (d < HOUR) return `${Math.floor(d / MINUTE)} min ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`;
  if (d < 7 * DAY) return `${Math.floor(d / DAY)} d ago`;
  return shortDate(at);
}

function relativeFuture(d: number): string | null {
  if (d < HOUR) return `in ${Math.max(1, Math.round(d / MINUTE))} min`;
  if (d < DAY) return `in ${Math.round(d / HOUR)} h`;
  if (d < 30 * DAY) return `in ${Math.round(d / DAY)} d`;
  return null;
}

/** "Nov 7, 2026, 14:05:09" in the viewer's locale and time zone. */
export function absoluteTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

export function shortDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** A future time for an expiry: relative when soon, a date otherwise. */
export function expiryLabel(at: number | null, now: number = Date.now()): string {
  if (at == null) return "Never";
  if (at <= now) return "Expired";
  return relativeFuture(at - now) ?? shortDate(at);
}

const GATE_KIND: Record<string, string> = { permission: "Tool permission", approval: "Approval", connect: "Connection" };
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
