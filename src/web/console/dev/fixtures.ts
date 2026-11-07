/**
 * Realistic console fixtures with generic placeholder names, for the dev stub
 * (VITE_STUB=1) and the Playwright smoke tests. Plain data, no DOM: anything
 * can import it. Times are relative to `now` so "5 min ago" stays true.
 */
import type {
  AgentDetailResponse, AuditEventView, ConsoleGrantView, ConsoleRolesResponse, GrantView, MandateView,
} from "../../../gateway/panel/api-types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface ConsoleFixtures {
  me: { email: string; role: "superadmin" | "operator" };
  roles: ConsoleRolesResponse;
  /** Agent details by name; summaries are derived from these. */
  agents: Record<string, AgentDetailResponse>;
  /** Newest first. */
  audit: AuditEventView[];
  counts: { liveSessions: number; pendingApprovals: number };
}

const LONG_CRON = [
  "Every weekday morning, read the open items in the team tracker and the last day of messages in #CTEAM.",
  "Post one short digest in the thread of the pinned standup message: what shipped, what is blocked and who is waiting on whom.",
  "Group items by owner. Link each item once. Skip anything that has not changed since the previous digest.",
  "If nothing changed, post a single line saying so rather than an empty digest.",
  "Never mention people who are out of office; their items go under a separate heading at the end.",
  "Keep the digest under twenty lines.",
].join("\n");

function defaultMandates(now: number): MandateView[] {
  const note = "scope-matched per request";
  return [
    {
      id: "global", kind: "global", title: "Global mandate", source: "soul", approverNote: note,
      instructions: "Help the team ship: answer questions about the codebase, review pull requests when asked, and keep threads moving. Ask before anything that changes shared infrastructure.",
      triggers: ["any admitted message"], approvers: ["UALICE"],
    },
    {
      id: "channel:CTEAM", kind: "channel", title: "Mandate in <#CTEAM>", source: "soul", channelId: "CTEAM", approverNote: note,
      instructions: "In the team channel, answer only when mentioned or when a question goes unanswered for an hour. Keep replies in threads.",
      triggers: ["messages in <#CTEAM>"], approvers: ["UALICE", "UBOB"],
    },
    {
      id: "channel:COPS", kind: "channel", title: "Mandate in <#COPS>", source: "soul", channelId: "COPS", approverNote: note,
      instructions: "", inheritsGlobal: true, proactive: { enabled: true, highest: "ask" },
      triggers: ["messages in <#COPS>"], approvers: [],
    },
    {
      id: "heartbeat", kind: "heartbeat", title: "Heartbeat", source: "proactive", approverNote: note,
      instructions: "Watches: issue-tracker, ci-status. Highest action: ask.",
      triggers: ["heartbeat round", "wake"], approvers: ["UALICE"],
    },
    {
      id: "cron:c_standup", kind: "cron", title: "Every weekday morning, read the open items in the team tracker and the last day of...", source: "cron",
      instructions: LONG_CRON, triggers: ["cron 0 9 * * 1-5"], approvers: ["UALICE"], approverNote: note,
      channelId: "CTEAM", schedule: "0 9 * * 1-5", lastRunAt: now - 5 * HOUR,
    },
    {
      id: "cron:c_weekly", kind: "cron", title: "Summarise the week's incidents for the ops channel", source: "cron",
      instructions: "Summarise the week's incidents for the ops channel.", triggers: ["cron 0 16 * * 5"], approvers: ["UALICE"], approverNote: note,
      channelId: "COPS", schedule: "0 16 * * 5", lastRunAt: null,
    },
  ];
}

function scoutMandates(): MandateView[] {
  return [
    {
      id: "global", kind: "global", title: "Global mandate", source: "soul",
      instructions: "Research questions the team brings: read the sources, cite them, and say plainly when the answer is not known.",
      triggers: ["any admitted message"], approvers: [],
    },
    {
      id: "channel:CTEAM", kind: "channel", title: "Mandate in <#CTEAM>", source: "soul", channelId: "CTEAM",
      instructions: "Answer research requests in threads only.", triggers: ["messages in <#CTEAM>"], approvers: ["UALICE", "UBOB"],
      proactive: { enabled: false },
    },
  ];
}

function consoleGrant(g: Omit<ConsoleGrantView, "source">): ConsoleGrantView {
  return { source: "console", ...g };
}

export function createFixtures(now: number = Date.now()): ConsoleFixtures {
  const soulDefault: GrantView[] = [
    { source: "soul", subjectKind: "user", subjectId: "UALICE", role: "manager", deny: false, dmOnly: false, channelId: null },
    { source: "soul", subjectKind: "channel", subjectId: "CTEAM", role: "member", deny: false, dmOnly: false, channelId: null },
    { source: "soul", subjectKind: "channel", subjectId: "COPS", role: "member", deny: false, dmOnly: false, channelId: null },
    { source: "soul", subjectKind: "user", subjectId: "UBOB", role: "approver", deny: false, dmOnly: false, channelId: "CTEAM" },
  ];
  const consoleDefault: ConsoleGrantView[] = [
    consoleGrant({
      id: "g_01", subjectKind: "user", subjectId: "UBOB", role: "member", deny: false, dmOnly: true,
      createdBy: "jane.doe@example.com", createdAt: now - 3 * DAY, expiresAt: null, note: "Pairing on the release checklist",
    }),
    consoleGrant({
      id: "g_02", subjectKind: "user", subjectId: "UCAROL", role: "member", deny: true, dmOnly: false,
      createdBy: "jane.doe@example.com", createdAt: now - 9 * DAY, expiresAt: null, note: "Moved to another team",
    }),
    consoleGrant({
      id: "g_03", subjectKind: "workspace", subjectId: "TWORKSPACE", role: "member", deny: false, dmOnly: false,
      createdBy: "alice@example.com", createdAt: now - DAY, expiresAt: now + 14 * DAY, note: null,
    }),
  ];
  const scoutGrants: GrantView[] = [
    { source: "soul", subjectKind: "channel", subjectId: "CTEAM", role: "member", deny: false, dmOnly: false, channelId: null },
    consoleGrant({
      id: "g_04", subjectKind: "user", subjectId: "UALICE", role: "approver", deny: false, dmOnly: false,
      createdBy: "jane.doe@example.com", createdAt: now - 2 * HOUR, expiresAt: now + 6 * HOUR, note: "Covering approvals this week",
    }),
  ];

  const detail = (
    d: Omit<AgentDetailResponse, "mandateCount" | "grantCount">,
  ): AgentDetailResponse => ({
    ...d,
    mandateCount: d.mandates.length,
    grantCount: d.grants.filter((g) => g.source === "console").length,
  });

  const agents: Record<string, AgentDetailResponse> = {
    default: detail({
      name: "default", slackUserId: null, model: null, runsOn: "local", live: true,
      mandates: defaultMandates(now), grants: [...soulDefault, ...consoleDefault],
    }),
    scout: detail({
      name: "scout", slackUserId: "USCOUT", model: "claude-sonnet-4-5", runsOn: "gpu-pool", live: true,
      mandates: scoutMandates(), grants: scoutGrants,
    }),
    triage: detail({
      name: "triage", slackUserId: "UTRIAGE", model: "claude-haiku-4-5", runsOn: "edge", live: false,
      mandates: [], grants: [],
    }),
  };

  return {
    me: { email: "jane.doe@example.com", role: "superadmin" },
    roles: { superadmin: ["jane.doe@example.com", "alice@example.com"], operator: ["bob@example.com", "oncall@example.com"] },
    agents,
    audit: auditTrail(now),
    counts: { liveSessions: 3, pendingApprovals: 2 },
  };
}

type Seed = Omit<AuditEventView, "id" | "at" | "details"> & { ago: number };

const SEEDS: Seed[] = [
  { ago: 2 * MIN, persona: "default", actorKind: "slack_user", actorId: "UALICE", action: "gate.permission.decided", targetKind: "tool", targetId: "Bash", decision: "allow", sessionId: "s_7f21", channelId: "CTEAM", summary: "Allowed Bash: run the test suite" },
  { ago: 6 * MIN, persona: "scout", actorKind: "operator", actorId: "jane.doe@example.com", action: "grant.created", targetKind: "grant", targetId: "g_04", decision: null, summary: "approver for user UALICE" },
  { ago: 18 * MIN, persona: "default", actorKind: "slack_user", actorId: "UBOB", action: "gate.approval.decided", targetKind: "approval", targetId: "deploy", decision: "deny", sessionId: "s_7f21", channelId: "COPS", summary: "Denied: restart the staging deploy" },
  { ago: 41 * MIN, persona: "default", actorKind: "system", actorId: "gateway", action: "gate.permission.expired", targetKind: "tool", targetId: "Write", decision: "expired", sessionId: "s_6a02", summary: "Nobody answered within 30 minutes" },
  { ago: 2 * HOUR, persona: "scout", actorKind: "slack_user", actorId: "UBOB", action: "gate.permission.refused", targetKind: "tool", targetId: "WebFetch", decision: "refused", sessionId: "s_5c90", summary: "UBOB is not an approver here" },
  { ago: 3 * HOUR, persona: "default", actorKind: "slack_user", actorId: "UALICE", action: "gate.connect.decided", targetKind: "mcp_server", targetId: "issue-tracker", decision: "allow", sessionId: "s_5c11", summary: "Connected issue-tracker for this thread" },
  { ago: 5 * HOUR, persona: "default", actorKind: "agent", actorId: "default", action: "proposal.decided", targetKind: "proposal", targetId: "p_19", decision: "approve", summary: "Memory page update approved" },
  { ago: 9 * HOUR, persona: "default", actorKind: "operator", actorId: "alice@example.com", action: "grant.created", targetKind: "grant", targetId: "g_03", decision: null, summary: "member for workspace TWORKSPACE" },
  { ago: 14 * HOUR, persona: "triage", actorKind: "operator", actorId: "jane.doe@example.com", action: "control.stop", targetKind: "session", targetId: "s_4d77", decision: null, sessionId: "s_4d77", summary: "Stopped a runaway turn" },
  { ago: 20 * HOUR, persona: "default", actorKind: "slack_user", actorId: "UALICE", action: "gate.permission.decided", targetKind: "tool", targetId: "Edit", decision: "always", sessionId: "s_4a10", summary: "Always allow Edit in this thread" },
  { ago: 26 * HOUR, persona: "default", actorKind: "operator", actorId: "jane.doe@example.com", action: "grant.revoked", targetKind: "grant", targetId: "g_00", decision: null, summary: "revoked member for user UDAVE" },
  { ago: 2 * DAY, persona: "scout", actorKind: "system", actorId: "gateway", action: "persona.sync", targetKind: "persona", targetId: "scout", decision: null, summary: "Synced from the personas repository" },
];

function auditTrail(now: number): AuditEventView[] {
  const out: AuditEventView[] = SEEDS.map((s, i) => {
    const { ago, ...rest } = s;
    return { id: `a_${String(1000 - i).padStart(4, "0")}`, at: now - ago, details: {}, ...rest };
  });
  // A longer tail for paging: routine decisions over the past days.
  const tools = ["Bash", "Read", "Edit", "WebFetch", "Write"];
  for (let i = 0; i < 48; i++) {
    const persona = i % 3 === 0 ? "scout" : "default";
    const tool = tools[i % tools.length]!;
    const allow = i % 4 !== 0;
    out.push({
      id: `a_${String(900 - i).padStart(4, "0")}`,
      at: now - 2 * DAY - i * 3 * HOUR,
      persona,
      actorKind: "slack_user",
      actorId: i % 2 ? "UALICE" : "UBOB",
      action: "gate.permission.decided",
      targetKind: "tool",
      targetId: tool,
      decision: allow ? "allow" : "deny",
      sessionId: `s_${(0x3000 + i).toString(16)}`,
      channelId: i % 2 ? "CTEAM" : "COPS",
      summary: `${allow ? "Allowed" : "Denied"} ${tool}`,
      details: {},
    });
  }
  return out;
}
