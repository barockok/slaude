import { describe, expect, test } from "bun:test";
import type { AuditEventView } from "../../src/gateway/panel/api-types";
import {
  ACTOR_KIND_LABEL, PERMISSION_MODE_LABEL, absoluteTime, actionLabel, actorKindLabel, auditAgent, auditTarget, auditHref, auditLinkFor, clockTime, decisionLabel,
  decisionTone, duration, expiryLabel, relativeTime, sessionPath, sessionStatus, shortDate,
} from "../../src/web/console/lib/format";

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("relativeTime", () => {
  test("past times step from just now to days, then a date", () => {
    expect(relativeTime(NOW, NOW)).toBe("just now");
    expect(relativeTime(NOW - 59_000, NOW)).toBe("just now");
    expect(relativeTime(NOW - 5 * MIN, NOW)).toBe("5 min ago");
    expect(relativeTime(NOW - 3 * HOUR, NOW)).toBe("3 h ago");
    expect(relativeTime(NOW - 2 * DAY, NOW)).toBe("2 d ago");
    expect(relativeTime(NOW - 10 * DAY, NOW)).toBe(shortDate(NOW - 10 * DAY));
  });
  test("future times read as in N", () => {
    expect(relativeTime(NOW + 20 * 1000, NOW)).toBe("in 1 min");
    expect(relativeTime(NOW + 2 * HOUR, NOW)).toBe("in 2 h");
    expect(relativeTime(NOW + 4 * DAY, NOW)).toBe("in 4 d");
    expect(relativeTime(NOW + 90 * DAY, NOW)).toBe(absoluteTime(NOW + 90 * DAY));
  });
  test("defaults now to the clock", () => {
    expect(relativeTime(Date.now())).toBe("just now");
  });
});

describe("expiryLabel", () => {
  test("never, expired, relative, then a date", () => {
    expect(expiryLabel(null, NOW)).toBe("Never");
    expect(expiryLabel(NOW, NOW)).toBe("Expired");
    expect(expiryLabel(NOW + 3 * HOUR, NOW)).toBe("in 3 h");
    expect(expiryLabel(NOW + 60 * DAY, NOW)).toBe(shortDate(NOW + 60 * DAY));
    expect(expiryLabel(Date.now() + 2 * DAY)).toBe("in 2 d");
  });
});

describe("actionLabel", () => {
  test("known actions have fixed labels", () => {
    expect(actionLabel("grant.created")).toBe("Grant added");
    expect(actionLabel("control.unlock-1on1")).toBe("1:1 lock released from console");
    expect(actionLabel("auth.denied")).toBe("Console sign-in denied");
  });
  test("gate actions combine the gate kind and outcome", () => {
    expect(actionLabel("gate.permission.decided")).toBe("Tool permission decided");
    expect(actionLabel("gate.approval.refused")).toBe("Approval click refused");
    expect(actionLabel("gate.mcp_connect.expired")).toBe("Connection expired");
    expect(actionLabel("gate.connect.reopened")).toBe("Connection reopened");
  });
  test("an unknown gate kind and other actions fall back to sentence case", () => {
    expect(actionLabel("gate.other.decided")).toBe("Gate other decided");
    expect(actionLabel("it.retention_old")).toBe("It retention old");
    expect(actionLabel("...")).toBe("...");
  });
});

describe("decisions", () => {
  test("tone by outcome family", () => {
    expect(decisionTone("allow")).toBe("success");
    expect(decisionTone("Always")).toBe("success");
    expect(decisionTone("deny")).toBe("danger");
    expect(decisionTone("refused")).toBe("danger");
    expect(decisionTone("expired")).toBe("warning");
    expect(decisionTone("pending")).toBe("warning");
    expect(decisionTone("something")).toBe("neutral");
  });
  test("label in sentence case", () => {
    expect(decisionLabel("timed_out")).toBe("Timed out");
    expect(decisionLabel("")).toBe("");
  });
});

describe("audit links", () => {
  test("auditHref keeps only set parameters", () => {
    expect(auditHref({})).toBe("/audit");
    expect(auditHref({ persona: "scout", action: null, session: undefined, actor: "" })).toBe("/audit?persona=scout");
  });
  test("auditLinkFor narrows to the event's kind and context", () => {
    const e = { persona: "scout", action: "grant.created", sessionId: "s_1" } as AuditEventView;
    expect(auditLinkFor(e)).toBe("/audit?persona=scout&action=grant.created&session=s_1");
    expect(auditLinkFor({ ...e, persona: null, sessionId: null } as AuditEventView)).toBe("/audit?action=grant.created");
  });
});

describe("sessions", () => {
  test("status labels and tones; unknown values pass through", () => {
    expect(sessionStatus("running")).toEqual({ label: "Running", tone: "accent" });
    expect(sessionStatus("error").tone).toBe("danger");
    expect(sessionStatus("paused")).toEqual({ label: "Paused", tone: "neutral" });
    expect(sessionStatus("")).toEqual({ label: "Unknown", tone: "neutral" });
  });
  test("sessionPath omits the default tab and encodes the id", () => {
    expect(sessionPath("s_1")).toBe("/sessions/s_1");
    expect(sessionPath("s_1", "timeline")).toBe("/sessions/s_1");
    expect(sessionPath("a/b", "chat")).toBe("/sessions/a%2Fb/chat");
  });
  test("labels for modes and actor kinds", () => {
    expect(PERMISSION_MODE_LABEL.plan).toBe("Plan only");
    expect(ACTOR_KIND_LABEL.slack_user).toBe("Slack user");
  });
});

describe("durations and clock", () => {
  test("duration picks a unit", () => {
    expect(duration(-5)).toBe("0 ms");
    expect(duration(850)).toBe("850 ms");
    expect(duration(4200)).toBe("4.2 s");
    expect(duration(3 * MIN + 5000)).toBe("3 min 05 s");
  });
  test("clockTime is a 24-hour time of day", () => {
    expect(clockTime(NOW)).toMatch(/\d{2}\D\d{2}\D\d{2}/);
  });
});

describe("audit labels", () => {
  test("an operator row says the console role it records", () => {
    expect(actorKindLabel({ actorKind: "operator", details: { role: "superadmin" } })).toBe("Superadmin");
    expect(actorKindLabel({ actorKind: "operator", details: { operatorRole: "operator" } })).toBe("Operator");
    expect(actorKindLabel({ actorKind: "operator", details: {} })).toBe("Operator");
    // A grant row: details.role is the granted role; the operator's is operatorRole.
    expect(actorKindLabel({ actorKind: "operator", details: { role: "approver", operatorRole: "superadmin" } })).toBe("Superadmin");
    expect(actorKindLabel({ actorKind: "operator", details: { role: "approver" } })).toBe("Operator");
    expect(actorKindLabel({ actorKind: "slack_user", details: { role: "superadmin" } })).toBe("Slack user");
  });
  test("console-wide rows belong to no agent, older default-agent sign-ins included", () => {
    expect(auditAgent({ persona: null, action: "panel.auth.login" })).toBeNull();
    expect(auditAgent({ persona: "default", action: "panel.auth.login" })).toBeNull();
    expect(auditAgent({ persona: "default", action: "panel.config.reload" })).toBeNull();
    expect(auditAgent({ persona: "default", action: "panel.console.roles.read" })).toBeNull();
    expect(auditAgent({ persona: "default", action: "grant.created" })).toBe("default");
    expect(auditAgent({ persona: "scout", action: "panel.auth.login" })).toBe("scout");
  });
  test("a channel target shows its name when resolved", () => {
    expect(auditTarget({ targetKind: "channel", targetId: "CTEAM", targetLabel: "#team" })).toBe("channel #team");
    expect(auditTarget({ targetKind: "mcp_server", targetId: "issue-tracker" })).toBe("mcp server issue-tracker");
    expect(auditTarget({ targetKind: null, targetId: null })).toBeNull();
  });
});
