/**
 * Realistic console fixtures with generic placeholder names, for the dev stub
 * (VITE_STUB=1) and the Playwright smoke tests. Plain data, no DOM: anything
 * can import it. Times are relative to `now` so "5 min ago" stays true.
 */
import type {
  AgentDetailResponse, AllGrantsResponse, AuditEventView, ConsoleGrantView, ConsoleRolesResponse, EnvironmentsResponse, GrantView,
  MandateView, MemoryPageResponse, MemoryStoreView, SessionEvent, SessionHistoryItem, SessionRowView, SessionSummaryView,
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
  /** Session rows, newest activity first, with their warm state. */
  sessions: Array<SessionRowView & Pick<SessionSummaryView, "warm" | "node">>;
  /** Console lock owner by session id. */
  locks: Record<string, string>;
  memory: { stores: MemoryStoreView[]; pages: Record<string, MemoryPageResponse[]> };
  environments: EnvironmentsResponse;
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
      id: "channel:CTEAM", kind: "channel", title: "Mandate in #team", source: "soul", channelId: "CTEAM", channelLabel: "#team", approverNote: note,
      instructions: "In the team channel, answer only when mentioned or when a question goes unanswered for an hour. Keep replies in threads.",
      triggers: ["messages in #team"], approvers: ["UALICE", "UBOB"],
    },
    {
      id: "channel:COPS", kind: "channel", title: "Mandate in #ops", source: "soul", channelId: "COPS", channelLabel: "#ops", approverNote: note,
      instructions: "", inheritsGlobal: true, proactive: { enabled: true, highest: "ask" },
      triggers: ["messages in #ops"], approvers: [],
    },
    {
      id: "heartbeat", kind: "heartbeat", title: "Heartbeat", source: "proactive", approverNote: note,
      instructions: "Watches: issue-tracker, ci-status. Highest action: ask. Works on its own in #ops.",
      triggers: ["heartbeat round", "wake"], approvers: ["UALICE"],
    },
    {
      id: "cron:c_standup", kind: "cron", title: "Every weekday morning, read the open items in the team tracker and the last day of...", source: "cron",
      instructions: LONG_CRON, triggers: ["cron 0 9 * * 1-5"], approvers: ["UALICE"], approverNote: note,
      channelId: "CTEAM", channelLabel: "#team", schedule: "0 9 * * 1-5", lastRunAt: now - 5 * HOUR,
    },
    {
      id: "cron:c_weekly", kind: "cron", title: "Summarise the week's incidents for the ops channel", source: "cron",
      instructions: "Summarise the week's incidents for the ops channel.", triggers: ["cron 0 16 * * 5"], approvers: ["UALICE"], approverNote: note,
      channelId: "COPS", channelLabel: "#ops", schedule: "0 16 * * 5", lastRunAt: null,
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
      id: "channel:CTEAM", kind: "channel", title: "Mandate in #team", source: "soul", channelId: "CTEAM", channelLabel: "#team",
      instructions: "Answer research requests in threads only.", triggers: ["messages in #team"], approvers: ["UALICE", "UBOB"],
      proactive: { enabled: false },
    },
  ];
}

/** A filesystem persona: mandates from its soul text, wakes switched on by a channel block. */
function triageMandates(now: number): MandateView[] {
  return [
    {
      id: "global", kind: "global", title: "Global mandate", source: "soul",
      instructions: "Sort incoming alerts: page the on-call engineer for anything customer facing, file the rest.",
      triggers: ["any admitted message"], approvers: ["UALICE"],
    },
    {
      id: "channel:CALERTS", kind: "channel", title: "Mandate in #CALERTS", source: "soul", channelId: "CALERTS",
      instructions: "", inheritsGlobal: true, proactive: { enabled: true }, triggers: ["messages in #CALERTS"], approvers: ["UALICE"],
    },
    {
      id: "heartbeat", kind: "heartbeat", title: "Heartbeat", source: "proactive",
      instructions: "Works on its own in #CALERTS.", triggers: ["heartbeat round", "wake"], approvers: ["UALICE"],
    },
    {
      id: "cron:c_sweep", kind: "cron", title: "Sweep unacknowledged alerts", source: "cron",
      instructions: "Sweep unacknowledged alerts", triggers: ["cron */30 * * * *"], approvers: ["UALICE"],
      channelId: "CALERTS", schedule: "*/30 * * * *", lastRunAt: now - 12 * MIN,
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
      mandates: triageMandates(now), grants: [],
    }),
  };

  return {
    me: { email: "jane.doe@example.com", role: "superadmin" },
    roles: { superadmin: ["jane.doe@example.com", "alice@example.com"], operator: ["bob@example.com", "oncall@example.com"] },
    agents,
    audit: auditTrail(now),
    // Active (warm) sessions: s_7f21 and s_5c90.
    counts: { liveSessions: 2, pendingApprovals: 2 },
    sessions: sessionRows(now),
    locks: { s_7f21: "bob@example.com", s_5c90: "alice@example.com" },
    memory: memoryFixtures(now),
    environments: environmentFixtures(now),
  };
}

type Seed = Omit<AuditEventView, "id" | "at" | "details"> & { ago: number };

const SEEDS: Seed[] = [
  { ago: 2 * MIN, persona: "default", actorKind: "slack_user", actorId: "UALICE", action: "gate.permission.decided", targetKind: "tool", targetId: "Bash", decision: "allow", sessionId: "s_7f21", channelId: "CTEAM", summary: "Allowed Bash: run the test suite" },
  { ago: 6 * MIN, persona: "scout", actorKind: "operator", actorId: "jane.doe@example.com", action: "grant.created", targetKind: "grant", targetId: "g_04", decision: null, summary: "approver for user UALICE" },
  { ago: 18 * MIN, persona: "default", actorKind: "slack_user", actorId: "UBOB", action: "gate.approval.decided", targetKind: "approval", targetId: "deploy", decision: "deny", sessionId: "s_7f21", channelId: "COPS", summary: "Denied: restart the staging deploy" },
  { ago: 41 * MIN, persona: "default", actorKind: "system", actorId: "gateway", action: "gate.permission.expired", targetKind: "tool", targetId: "Write", decision: "expired", sessionId: "s_6a02", summary: "Nobody answered within 30 minutes" },
  { ago: 2 * HOUR, persona: "scout", actorKind: "slack_user", actorId: "UBOB", action: "gate.permission.refused", targetKind: "tool", targetId: "WebFetch", decision: "refused", sessionId: "s_5c90", summary: "UBOB is not an approver here" },
  { ago: 3 * HOUR, persona: "default", actorKind: "slack_user", actorId: "UALICE", action: "gate.mcp_connect.decided", targetKind: "mcp_server", targetId: "issue-tracker", decision: "allow", sessionId: "s_5c11", summary: "Connected issue-tracker for this thread" },
  { ago: 4 * HOUR, persona: null, actorKind: "operator", actorId: "jane.doe@example.com", action: "memory.page.viewed", targetKind: "memory_page", targetId: "user-ualice/preferences", decision: null, summary: "viewed a personal memory page" },
  // An agent actor is recorded by its bot user id; the gateway names it by its agent (actorLabel).
  { ago: 5 * HOUR, persona: "scout", actorKind: "agent", actorId: "USCOUT", actorLabel: "scout", action: "skill.retired", targetKind: "skill", targetId: "standup-notes", decision: null, summary: "retired skill standup-notes" },
  { ago: 9 * HOUR, persona: "default", actorKind: "operator", actorId: "alice@example.com", action: "grant.created", targetKind: "grant", targetId: "g_03", decision: null, summary: "member for workspace TWORKSPACE" },
  { ago: 12 * HOUR, persona: "default", actorKind: "operator", actorId: "bob@example.com", action: "panel.session.control", targetKind: "session", targetId: "s_7f21", decision: null, sessionId: "s_7f21", summary: "Changed the model to claude-sonnet-4-5" },
  { ago: 14 * HOUR, persona: "triage", actorKind: "operator", actorId: "jane.doe@example.com", action: "control.stop", targetKind: "session", targetId: "s_4d77", decision: null, sessionId: "s_4d77", summary: "Stopped a runaway turn" },
  { ago: 20 * HOUR, persona: "default", actorKind: "slack_user", actorId: "UALICE", action: "gate.permission.decided", targetKind: "tool", targetId: "Edit", decision: "always", sessionId: "s_4a10", summary: "Always allow Edit in this thread" },
  { ago: 26 * HOUR, persona: "default", actorKind: "operator", actorId: "jane.doe@example.com", action: "grant.revoked", targetKind: "grant", targetId: "g_00", decision: null, summary: "revoked member for user UDAVE" },
  { ago: 2 * DAY, persona: "scout", actorKind: "system", actorId: "gateway", action: "persona.sync", targetKind: "persona", targetId: "scout", decision: null, summary: "Synced from the personas repository" },
  // Console-wide: no agent. The second is an older row written under the default agent.
  { ago: 30 * MIN, persona: null, actorKind: "operator", actorId: "alice@example.com", action: "panel.config.reload", targetKind: null, targetId: null, decision: null, summary: "reload" },
  { ago: 47 * HOUR, persona: "default", actorKind: "operator", actorId: "jane.doe@example.com", action: "panel.auth.login", targetKind: null, targetId: null, decision: null, summary: "auth.login" },
];

function auditTrail(now: number): AuditEventView[] {
  const out: AuditEventView[] = SEEDS.map((s, i) => {
    const { ago, ...rest } = s;
    const label = rest.channelId ? CHANNEL_LABELS[rest.channelId] : undefined;
    return { id: `a_${String(1000 - i).padStart(4, "0")}`, at: now - ago, details: detailsFor(rest), ...rest, ...(label ? { channelLabel: label } : {}) };
  }).sort((a, b) => b.at - a.at);
  out.forEach((e, i) => (e.id = `a_${String(1000 - i).padStart(4, "0")}`));
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
      channelLabel: i % 2 ? "#team" : "#ops",
      summary: `${allow ? "Allowed" : "Denied"} ${tool}`,
      details: {},
    });
  }
  return out;
}

/** GET /panel/api/grants over the fixtures: unexpired console grants by persona, then age. */
export function allGrantsOf(fx: ConsoleFixtures, now: number = Date.now()): AllGrantsResponse {
  const grants = Object.values(fx.agents)
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((a) =>
      a.grants
        .filter((g): g is ConsoleGrantView => g.source === "console" && (g.expiresAt === null || g.expiresAt > now))
        .sort((x, y) => x.createdAt - y.createdAt)
        .map((g) => ({ ...g, persona: a.name })),
    );
  return { grants };
}

/** Redacted-looking details for a seeded event, so the audit drawer has something to show. */
function detailsFor(e: Omit<Seed, "ago">): Record<string, unknown> {
  if (e.action.startsWith("gate.")) {
    return {
      gateId: `pg_${e.targetId?.toLowerCase() ?? "x"}_01`,
      tool: e.targetId,
      input: e.targetId === "Bash" ? { command: "bun test tests/panel", timeout: 120000 } : { file_path: "src/web/console/App.tsx" },
      channelId: e.channelId ?? null,
      approvers: ["UALICE", "UBOB"],
      token: "[redacted]",
    };
  }
  if (e.action.startsWith("grant.")) return { grantId: e.targetId, role: "approver", subjectKind: "user", subjectId: "UALICE", expiresAt: null, operatorRole: "superadmin" };
  if (e.action.startsWith("panel.")) return { panelAction: e.summary, role: e.actorId === "bob@example.com" ? "operator" : "superadmin", outcome: "ok" };
  if (e.action === "memory.page.viewed") return { store: "user-ualice", slug: "preferences", storeKind: "personal", operatorRole: "superadmin" };
  return {};
}

/** What the gateway's Slack name lookup answers for the fixture channels (CGONE: the app is not in it). */
export const CHANNEL_LABELS: Record<string, string> = { CTEAM: "#team", COPS: "#ops", CALERTS: "#alerts", DUALICE: "DM with alice" };

/** Names of the people mentioned in fixture messages. */
export const USER_NAMES: Record<string, string> = { UALICE: "alice", UBOB: "bob" };

// --- Sessions ----------------------------------------------------------------

const TS = (n: number) => `${Math.floor((Date.parse("2026-11-07T09:00:00Z") + n * 60_000) / 1000)}.00${String(100 + n).padStart(4, "0")}`;

function sessionRows(now: number): ConsoleFixtures["sessions"] {
  const row = (
    id: string, persona: string, channel: string | null, thread: string | null, status: string, model: string, ago: number,
    over: Partial<SessionRowView & { warm: boolean; node: string }> = {},
  ) => ({
    id, persona_id: persona, slack_team_id: "TWORKSPACE", slack_channel_id: channel, slack_thread_ts: thread, status, model,
    created_at: now - ago - 2 * HOUR, updated_at: now - ago, title: null, working_dir: `/home/slaude/workspaces/${id}`,
    claude_started: 1, engaged: 1, permission_mode: "default", warm: status === "running", node: status === "running" ? "node-a1" : undefined,
    ...over,
  });
  return [
    row("s_7f21", "default", "CTEAM", TS(1), "running", "claude-sonnet-4-5", 30_000, { title: "Release checklist for the console" }),
    row("s_5c90", "scout", "CTEAM", TS(2), "running", "claude-sonnet-4-5", 2 * MIN, { node: "node-g1", title: "Compare queue libraries" }),
    row("s_6a02", "default", "COPS", TS(3), "idle", "claude-opus-4-1", 41 * MIN, { permission_mode: "acceptEdits" }),
    row("s_5c11", "default", "CTEAM", TS(4), "idle", "claude-opus-4-1", 3 * HOUR, { title: "Connect the issue tracker" }),
    row("s_4d77", "triage", "COPS", TS(5), "error", "claude-haiku-4-5", 14 * HOUR, { title: "Nightly alert sweep" }),
    // Stored as running, but its node restarted long ago: nothing holds it (Idle).
    row("s_4a10", "default", "DUALICE", TS(6), "running", "claude-opus-4-1", 20 * HOUR, { engaged: 0, warm: false, node: undefined }),
    row("s_3001", "scout", "CTEAM", TS(7), "idle", "claude-sonnet-4-5", 2 * DAY, { claude_started: 0 }),
    row("s_2ff0", "default", null, null, "idle", "claude-opus-4-1", 3 * DAY, { title: "Heartbeat round", engaged: 0 }),
    // No model on the row: the agent's configured model, then the deployment default.
    row("s_1e40", "scout", "CGONE", TS(8), "idle", "", 3 * DAY + HOUR, { title: "Notes from a channel the app left" }),
    // Older sessions, past the first page of 50.
    ...Array.from({ length: 54 }, (_, i) =>
      row(`s_old${String(i + 1).padStart(2, "0")}`, "default", "CTEAM", TS(20 + i), "idle", "", 4 * DAY + i * 6 * HOUR, { title: `Older thread ${i + 1}` })),
  ];
}

/**
 * The live tail the stub plays for a session: one full turn with thinking,
 * two tool calls and a reply. `delay` is the wait before each frame (ms).
 */
export function sessionScript(sessionId: string): Array<{ delay: number; event: SessionEvent }> {
  const e = <T extends Omit<SessionEvent, "sessionId">>(delay: number, ev: T) => ({ delay, event: { sessionId, ...ev } as SessionEvent });
  return [
    e(60, { type: "userMessage", userId: "UALICE", userName: "alice", text: "Can you check the release checklist against the branch?", at: Date.now(), surface: "slack" }),
    e(60, { type: "turnStart" }),
    e(60, { type: "thinking", text: "The user wants the release checklist checked against the current branch. Start with the test suite, then read the checklist file and compare each item." }),
    e(60, { type: "assistantText", text: "Running the panel tests first, then I will go through the checklist item by item." }),
    e(60, { type: "toolCall", tool: "Bash", input: { command: "bun test tests/panel", description: "Run the panel test suite", timeout: 120000 }, toolUseId: "toolu_bash1" }),
    e(80, { type: "toolResult", tool: "Bash", result: { stdout: "bun test v1.3.0\n\ntests/panel/console-audit.test.ts:\n(pass) GET /panel/api/audit > newest first\n(pass) GET /panel/api/audit > filters\n\n 214 pass\n 0 fail\nRan 214 tests across 22 files. [8.41s]", is_error: false }, toolUseId: "toolu_bash1" }),
    // Two reads in parallel; their results come back in the other order and pair by id.
    e(60, { type: "toolCall", tool: "Read", input: { file_path: "docs/release-checklist.md" }, toolUseId: "toolu_read1" }),
    e(10, { type: "toolCall", tool: "Read", input: { file_path: "CHANGELOG.md" }, toolUseId: "toolu_read2" }),
    e(60, { type: "toolResult", tool: "Read", result: "## 0.42.0 (unreleased)\n- Console session history", toolUseId: "toolu_read2" }),
    e(60, { type: "toolResult", tool: "Read", result: "1. Tests pass on the release branch\n2. Release notes written under docs/site/_content/releases\n3. Version in package.json matches the tag\n4. Screenshots updated for changed pages", toolUseId: "toolu_read1" }),
    e(60, { type: "tokenUsage", snapshot: { inputTokens: 18200, outputTokens: 940, cacheReadInputTokens: 52000, cacheCreationInputTokens: 0, totalInput: 70200, contextWindow: 200000, pctUsed: 0.35, remaining: 129800 } }),
    e(60, { type: "toolCall", tool: "Edit", input: { file_path: "package.json", old_string: "\"version\": \"0.41.0\"", new_string: "\"version\": \"0.42.0-rc.1\"" }, toolUseId: "toolu_edit1" }),
    e(60, { type: "toolResult", tool: "Edit", result: { is_error: true, content: "Permission denied by UBOB in the thread" }, toolUseId: "toolu_edit1" }),
    e(60, { type: "toolCall", tool: "mcp__slaude_surface__reply", input: { text: "Tests pass (214 of 214). Release notes and screenshots are still open.\n\nThe version bump was declined in the thread, so package.json still says 0.41.0. Want me to draft the release notes next?" }, toolUseId: "toolu_reply1" }),
    e(60, { type: "toolResult", tool: "mcp__slaude_surface__reply", result: [{ type: "text", text: "posted ref=1762506060.000300" }], toolUseId: "toolu_reply1" }),
    e(60, { type: "done" }),
  ];
}

/**
 * A session's earlier turns as the history route answers them (oldest first),
 * from the conversation record. s_7f21 has more than one page.
 */
/** An agent reply written in markdown, as agents write them (rendered in the timeline and chat). */
export const AGENT_MARKDOWN = "Here is the **release plan**:\n\n1. Run the panel tests\n2. Tag `v0.41.0`\n\nSee [the runbook](https://example.com/runbook).";

export function sessionHistory(sessionId: string, now: number): SessionHistoryItem[] {
  if (sessionId === "s_2ff0") return [];
  const turns = sessionId === "s_7f21" ? 26 : 3;
  const out: SessionHistoryItem[] = [];
  for (let i = 1; i <= turns; i++) {
    const at = now - (turns - i + 1) * 7 * MIN - 2 * HOUR;
    const userText =
      i === 1 ? "Earliest question: where is the release checklist?"
      : i === turns - 1 ? "Ask <@UBOB> in <#COPS|ops> &amp; read <https://example.com/runbook|the runbook> first"
      : `Earlier question ${i}`;
    // A line from a scheduled run has no message time of its own: only its day is known.
    const userAt = i === 2 ? { at, dateOnly: true } : { at: at - 40_000 };
    out.push({ id: `${i}:user`, ...userAt, who: "user", name: i % 3 === 0 ? "bob" : "alice", text: userText, surface: "slack" });
    out.push({ id: `${i}:agent`, at, who: "agent", text: i === turns ? "Last earlier answer: the checklist lives in docs/release-checklist.md." : turns > 3 && i === turns - 1 ? AGENT_MARKDOWN : `Earlier answer ${i}`, surface: "slack" });
  }
  return out;
}

// --- Memory ------------------------------------------------------------------

function memoryFixtures(now: number): ConsoleFixtures["memory"] {
  const page = (store: string, slug: string, type: string, title: string, ago: number | null, over: Partial<MemoryPageResponse> = {}): MemoryPageResponse => ({
    store, slug, type, title, content: "", timeline: "", entries: [], entriesCapped: false, frontmatter: {}, tags: [], links: [],
    createdAt: ago == null ? null : now - ago - 20 * DAY, updatedAt: ago == null ? null : now - ago, ...over,
  });
  const runbook = page("shared", "runbooks/deploy-rollback", "runbook", "Rolling back a deploy", 2 * HOUR, {
    tags: ["deploy", "ops", "runbook"],
    frontmatter: { owner: "UALICE", reviewed: "2026-10-30", severity: "high", source: "thread CTEAM 1762500000.000100" },
    links: [
      { to: "systems/ci-pipeline", type: "depends_on", context: "The rollback job runs in the CI pipeline." },
      { to: "people/ualice", type: "owned_by", context: "Owner of the deploy tooling." },
      { to: "incidents/2026-10-12-stuck-deploy", type: "mentioned_in", context: "" },
    ],
    timeline: "- 2026-10-12: written after a stuck deploy\n- 2026-10-30: reviewed, step 3 changed to use the pinned image",
    content: [
      "# Rolling back a deploy",
      "",
      "Use this when a release is live and something is wrong enough that a fix forward would take longer than ten minutes.",
      "",
      "## Steps",
      "",
      "1. Announce the rollback in the ops channel with the release tag.",
      "2. Run the rollback job with the previous tag: `deploy rollback --to v0.41.0`.",
      "3. Pin the image so the next sync does not undo it. Very long command lines and URLs wrap instead of pushing the page sideways: https://example.com/ci/pipelines/deploy-rollback?tag=v0.41.0&pin=true&notify=ops",
      "4. Watch error rates for fifteen minutes before closing the incident.",
      "",
      "## Notes",
      "",
      "- Database migrations are forward only; a rollback never reverts them.",
      "- If the rollback job itself fails, page the on-call engineer.",
    ].join("\n"),
  });
  const shared = [
    runbook,
    page("shared", "decisions/queue-library", "decision", "Queue library choice", 1 * DAY, { tags: ["architecture"], content: "We keep the Redis streams queue. Re-evaluate when a second region is added." }),
    page("shared", "glossary/mandate", "concept", "Mandate", 3 * DAY, { content: "What an agent is asked to do in a scope: global, a channel, a schedule or a heartbeat." }),
    page("shared", "people/ualice", "person", "UALICE", 5 * DAY),
    page("shared", "systems/ci-pipeline", "system", "CI pipeline", 6 * DAY),
    ...Array.from({ length: 52 }, (_, i) =>
      page("shared", `notes/standup-${String(i + 1).padStart(2, "0")}`, "note", `Standup notes ${i + 1}`, (7 + i) * DAY)),
  ];
  const personal = [
    page("user-ualice", "preferences", "preference", "Working preferences", 4 * HOUR, {
      tags: ["private"], content: "Prefers short summaries with links. Reviews pull requests in the afternoon.", frontmatter: { subject: "UALICE" },
    }),
    page("user-ualice", "projects/console", "project", "Console rebuild", 2 * DAY),
  ];
  const agentMind = [
    page("agent-udefault", "lessons/ask-before-deploy", "lesson", "Ask before touching deploys", 9 * HOUR, { tags: ["lesson"], content: "Deploy changes need an approver in the thread, even when the request sounds routine." }),
    page("agent-udefault", "self/voice", "self", "Voice", null),
  ];
  const pages: Record<string, MemoryPageResponse[]> = {
    shared, "user-ualice": personal, "agent-udefault": agentMind,
    "agent-uscout": [], public: [page("public", "faq/how-to-ask", "faq", "How to ask the agents", 10 * DAY)],
    "profile-team": [page("profile-team", "ualice", "profile", "UALICE", 6 * HOUR)],
    "kb-handbook": [page("kb-handbook", "onboarding", "guide", "Onboarding", 30 * DAY)],
  };
  const stores: MemoryStoreView[] = [
    { id: "agent-udefault", kind: "agent", label: "Agent mind: default", pageCount: agentMind.length },
    { id: "agent-uscout", kind: "agent", label: "Agent mind: scout", pageCount: 0 },
    { id: "shared", kind: "shared", label: "Shared", pageCount: shared.length },
    { id: "public", kind: "public", label: "Public", pageCount: 1 },
    { id: "kb-handbook", kind: "library", label: "Library: handbook", pageCount: 1 },
    { id: "user-ualice", kind: "personal", label: "Personal: ualice", pageCount: personal.length },
    { id: "profile-team", kind: "profile", label: "Profile", pageCount: 1 },
  ];
  return { stores, pages };
}

// --- Environments ------------------------------------------------------------

function environmentFixtures(now: number): EnvironmentsResponse {
  return {
    nodePools: [
      { label: "edge", nodes: [] },
      { label: "gpu-pool", nodes: [{ id: "node-g1", lastSeen: now - 4_000 }, { id: "node-g2", lastSeen: now - 9_000 }] },
      { label: "local", nodes: [{ id: "node-a1", lastSeen: now - 2_000 }] },
    ],
    personas: [
      { name: "default", runsOn: "local" },
      { name: "scout", runsOn: "gpu-pool" },
      { name: "triage", runsOn: "edge" },
    ],
    personal: [
      { id: "env_01", owner: { teamId: "TWORKSPACE", userId: "UALICE" }, name: "laptop", kind: "tailcat", defaultDir: "~/code/app", createdAt: now - 12 * DAY },
      { id: "env_02", owner: { teamId: "TWORKSPACE", userId: "UBOB" }, name: "build-box", kind: "ssh", defaultDir: "/srv/build", createdAt: now - 3 * DAY },
      { id: "env_03", owner: { teamId: "TWORKSPACE", userId: "UCAROL" }, name: "sandbox", kind: "ssh", defaultDir: null, createdAt: now - 6 * HOUR },
    ],
  };
}
