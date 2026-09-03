// Realistic fixture fleet + a scripted event stream. Shared by the in-browser
// mock (?mock=1) and the Bun stub server that backs the e2e suite, so both
// render identical data with no live backend.
import type { SessionSummary, AgentEvent } from "./types";

// Anchored to load time so relative ages ("2m ago", "3h ago") read naturally
// in the gauntlet while exact-on-hover timestamps stay honest.
const now = Date.now();
const mins = (m: number) => now - m * 60_000;

export const OPERATOR = "ops@slaude.dev";

export const FIXTURE_SESSIONS: SessionSummary[] = [
  {
    id: "s_ravi_9f3c21", persona_id: "ravi", model: "claude-opus-4-8",
    status: "running", claude_started: 1, engaged: 1,
    title: "Reconcile Q3 settlement ledger", working_dir: "/workspaces/s_ravi_9f3c21",
    slack_team_id: "T09AB12CD", slack_channel_id: "C08FIN01A", slack_thread_ts: "1755990012.221100",
    created_at: mins(184), updated_at: mins(0), warm: true, node: "gw-node-2", ctx_pct: 0.62,
  },
  {
    id: "s_lena_47ab08", persona_id: "lena", model: "claude-sonnet-4-6",
    status: "waiting", claude_started: 1, engaged: 1,
    title: "Draft incident postmortem", working_dir: "/workspaces/s_lena_47ab08",
    slack_team_id: "T09AB12CD", slack_channel_id: "C07OPS22B", slack_thread_ts: "1755988800.100200",
    created_at: mins(96), updated_at: mins(2), warm: true, node: "gw-node-1",
    panel_locked_by: "maya@slaude.dev", ctx_pct: 0.41,
  },
  {
    id: "s_toko_1c9d55", persona_id: "toko", model: "claude-sonnet-4-6",
    status: "running", claude_started: 1, engaged: 1,
    title: "Migrate feature flags to typed config", working_dir: "/workspaces/s_toko_1c9d55",
    slack_team_id: "T09AB12CD", slack_channel_id: "C05ENG08C", slack_thread_ts: "1755985500.552000",
    created_at: mins(41), updated_at: mins(0), warm: true, node: "gw-node-2", ctx_pct: 0.88,
  },
  {
    id: "s_ravi_88ee02", persona_id: "ravi", model: "claude-opus-4-8",
    status: "idle", claude_started: 1, engaged: 0,
    title: "Weekly cohort retention summary", working_dir: "/workspaces/s_ravi_88ee02",
    slack_team_id: "T09AB12CD", slack_channel_id: "C06DATA4D", slack_thread_ts: "1755900000.900100",
    created_at: mins(1440), updated_at: mins(220), warm: false, ctx_pct: 0.17,
  },
  {
    id: "s_max_204fb7", persona_id: "max", model: "claude-haiku-4-5",
    status: "error", claude_started: 1, engaged: 1,
    title: "Sync vendor invoices from inbox", working_dir: "/workspaces/s_max_204fb7",
    slack_team_id: "T09AB12CD", slack_channel_id: "C04AP0X1E", slack_thread_ts: "1755980100.771200",
    created_at: mins(300), updated_at: mins(7), warm: true, node: "gw-node-3", ctx_pct: 0.54,
  },
  {
    id: "s_lena_60cc19", persona_id: "lena", model: "claude-sonnet-4-6",
    status: "done", claude_started: 1, engaged: 0,
    title: "Refactor onboarding checklist skill", working_dir: "/workspaces/s_lena_60cc19",
    slack_team_id: "T09AB12CD", slack_channel_id: "C05ENG08C", slack_thread_ts: "1755870000.330900",
    created_at: mins(2100), updated_at: mins(540), warm: false, ctx_pct: 0.33,
  },
  {
    id: "s_toko_aa71d0", persona_id: "toko", model: "claude-opus-4-8",
    status: "idle", claude_started: 0, engaged: 0,
    title: "Prototype churn-risk digest", working_dir: "/workspaces/s_toko_aa71d0",
    slack_team_id: "T09AB12CD", slack_channel_id: "C06DATA4D", slack_thread_ts: "1755860000.120400",
    created_at: mins(2600), updated_at: mins(880), warm: false, ctx_pct: 0.05,
  },
  {
    id: "s_max_33bd41", persona_id: "max", model: "claude-haiku-4-5",
    status: "running", claude_started: 1, engaged: 1,
    title: "Triage support backlog labels", working_dir: "/workspaces/s_max_33bd41",
    slack_team_id: "T09AB12CD", slack_channel_id: "C04SUP07F", slack_thread_ts: "1755984000.660100",
    created_at: mins(58), updated_at: mins(1), warm: true, node: "gw-node-1", ctx_pct: 0.71,
  },
];

export const DETAIL_ID = "s_ravi_9f3c21";

// A rich scripted turn for the detail/timeline/chat surfaces. `delay` is the
// gap (ms) before each frame: it drives BOTH the live replay cadence (scaled
// down so the tail drains fast) AND the virtual event clock the emitters stamp
// onto each frame, so the timeline shows a realistic, spread-out sequence with
// legible inter-event gaps (a 1.4s query, a 2.8s test run) instead of every
// event landing in the same wall-clock second.
export const SCRIPT: { delay: number; event: AgentEvent }[] = (() => {
  const sid = DETAIL_ID;
  return [
    { delay: 0, event: { type: "turnStart", sessionId: sid } },
    { delay: 400, event: { type: "assistantText", sessionId: sid, text: "Pulling the settlement export and the ledger snapshot so I can diff them line by line." } },
    { delay: 300, event: { type: "toolCall", sessionId: sid, tool: "Bash", input: { command: "psql -c \"select id, amount, status from settlements where batch='q3'\"" } } },
    { delay: 1400, event: { type: "toolResult", sessionId: sid, tool: "Bash", result: "1428 rows (14 flagged mismatched)" } },
    { delay: 500, event: { type: "thinking", sessionId: sid, text: "14 mismatches. Most look like rounding on partial refunds. Checking the refund join before I trust that." } },
    { delay: 250, event: { type: "toolCall", sessionId: sid, tool: "Read", input: { file_path: "/workspaces/s_ravi_9f3c21/ledger/reconcile.ts" } } },
    { delay: 620, event: { type: "toolResult", sessionId: sid, tool: "Read", result: "reconcile.ts (212 lines): rounds with Math.round, ledger uses bankers rounding" } },
    { delay: 240, event: { type: "tokenUsage", sessionId: sid, snapshot: { inputTokens: 61240, outputTokens: 3820, cacheReadInputTokens: 128400, cacheCreationInputTokens: 9200, totalInput: 198840, contextWindow: 320000, pctUsed: 0.62, remaining: 121160 } } },
    { delay: 900, event: { type: "assistantText", sessionId: sid, text: "Found it. The reconciler rounds half-up while the ledger uses bankers rounding, so 14 partial refunds drift by one cent. Patching reconcile.ts to match the ledger." } },
    { delay: 480, event: { type: "toolCall", sessionId: sid, tool: "Edit", input: { file_path: "ledger/reconcile.ts", old_string: "Math.round(cents)", new_string: "bankersRound(cents)" } } },
    { delay: 520, event: { type: "toolResult", sessionId: sid, tool: "Edit", result: "applied 1 edit" } },
    { delay: 300, event: { type: "toolCall", sessionId: sid, tool: "Bash", input: { command: "bun test ledger/reconcile.test.ts" } } },
    { delay: 2800, event: { type: "toolResult", sessionId: sid, tool: "Bash", result: "24 pass, 0 fail, all 14 mismatches resolved" } },
    { delay: 640, event: { type: "assistantText", sessionId: sid, text: "All 14 mismatches clear and the suite is green. Want me to open the PR against main or post the diff in this thread first?" } },
    { delay: 220, event: { type: "done", sessionId: sid } },
  ];
})();
