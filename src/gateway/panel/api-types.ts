/**
 * Response shapes of the console JSON API under `/panel/api/*` (agent
 * platform, console part). Self-contained on purpose: no imports, so the web
 * app can import this file without pulling server modules into its build. The
 * server annotates its responses with these types, so they cannot drift.
 *
 * Times are epoch milliseconds unless a field says otherwise.
 */

export type GrantRole = "manager" | "approver" | "member";
export type SubjectKind = "user" | "channel" | "workspace";

/** Error body of every non-2xx JSON response. */
export interface ApiError {
  error: string;
}

// --- Agents -----------------------------------------------------------------

export interface AgentSummary {
  /** Persona name; `default` is the deployment's default persona. */
  name: string;
  /** The persona's Slack user, or null (the default persona has none of its own). */
  slackUserId: string | null;
  /** Effective model, or null when the persona sets none (the deployment default applies). */
  model: string | null;
  /** Node label its turns run on. */
  runsOn: string;
  /**
   * Whether something can serve the agent right now: true in a single-process
   * (mono) deployment; with nodes, whether at least one live node carries
   * `runsOn`; null when that cannot be read (no node registry).
   */
  live: boolean | null;
  mandateCount: number;
  /** Stored console grants that have not expired. */
  grantCount: number;
}

export interface AgentsResponse {
  agents: AgentSummary[];
}

export type ProactiveLevel = "ignore" | "inform" | "ask" | "act";

export interface MandateView {
  id: string;
  kind: "global" | "channel" | "cron" | "heartbeat";
  title: string;
  instructions: string;
  triggers: string[];
  approvers: string[];
  source: "soul" | "cron" | "proactive";
  channelId?: string;
  lastRunAt?: number | null;
  schedule?: string;
  proactive?: { enabled: boolean; highest?: ProactiveLevel };
  inheritsGlobal?: boolean;
  approverNote?: string;
}

/** A grant derived from the persona's soul. Read-only. */
export interface SoulGrantView {
  source: "soul";
  subjectKind: SubjectKind;
  subjectId: string;
  role: GrantRole;
  deny: boolean;
  dmOnly: boolean;
  /** Set for an approver scoped to one channel by a soul channel block. */
  channelId: string | null;
}

/** A stored grant made in the console. Revocable by id. */
export interface ConsoleGrantView {
  source: "console";
  id: string;
  subjectKind: SubjectKind;
  subjectId: string;
  role: GrantRole;
  deny: boolean;
  dmOnly: boolean;
  createdBy: string;
  createdAt: number;
  expiresAt: number | null;
  note: string | null;
}

export type GrantView = SoulGrantView | ConsoleGrantView;

export interface AgentDetailResponse extends AgentSummary {
  mandates: MandateView[];
  /** Effective grants: soul-derived first, then stored (unexpired) console grants. */
  grants: GrantView[];
}

export interface AgentGrantsResponse {
  grants: GrantView[];
}

/** A stored console grant with the agent (persona) it is on. */
export interface PersonaConsoleGrantView extends ConsoleGrantView {
  persona: string;
}

/** GET /panel/api/grants: every unexpired console grant across agents, by persona then age. */
export interface AllGrantsResponse {
  grants: PersonaConsoleGrantView[];
}

/** Body of POST /panel/api/agents/:name/grants. */
export interface CreateGrantRequest {
  subjectKind: SubjectKind;
  subjectId: string;
  role: GrantRole;
  deny?: boolean;
  dmOnly?: boolean;
  /** Epoch ms in the future, or null/absent for never. */
  expiresAt?: number | null;
  note?: string | null;
}

export interface CreateGrantResponse {
  grant: ConsoleGrantView;
}

export interface RevokeGrantResponse {
  ok: true;
}

// --- Sessions ---------------------------------------------------------------
// Snake-case on purpose: these routes predate the console and answer database
// rows as they are (src/db/schema.ts SessionRow, panel/enumerator.ts).

/** One row of GET /panel/api/sessions: the stored row joined with the warm registry. */
export interface SessionSummaryView {
  id: string;
  persona_id: string;
  model: string;
  /**
   * The stored status. `running` means the session's CLI process was started
   * and not yet closed, not that a turn is in flight, and a row can stay
   * `running` after its node went away: show `activity` instead.
   */
  status: string;
  claude_started: number;
  engaged: number;
  title: string | null;
  working_dir: string;
  slack_team_id: string | null;
  slack_channel_id: string | null;
  slack_thread_ts: string | null;
  created_at: number;
  updated_at: number;
  tenant_id?: string;
  /** Warm right now: in the node registry (gateway) or live in this process (mono). */
  warm: boolean;
  /** What the session is doing now (see SessionActivity). */
  activity: SessionActivity;
  /** Owning node id when warm. */
  node?: string;
  /** Operator driving the session from the console, if any. */
  panel_locked_by?: string;
}

/**
 * `working`: a turn is in flight. `warm`: the CLI process is up and waiting
 * for the next message. `idle`: nothing is running (a stored `running` row
 * that no node or process holds is idle). `error`: the stored status says the
 * session failed and nothing holds it.
 */
export type SessionActivity = "working" | "warm" | "idle" | "error";

/** GET /panel/api/sessions?persona&status&limit&offset, newest first. */
export interface SessionsResponse {
  sessions: SessionSummaryView[];
}

/** The stored session row. */
export interface SessionRowView {
  id: string;
  created_at: number;
  updated_at: number;
  title: string | null;
  model: string;
  working_dir: string;
  status: string;
  claude_started: number;
  slack_team_id: string | null;
  slack_channel_id: string | null;
  slack_thread_ts: string | null;
  permission_mode: string;
  engaged: number;
  persona_id: string;
  slack_app_id?: string | null;
}

/** GET /panel/api/sessions/:id */
export interface SessionDetailResponse {
  session: SessionRowView;
  /** Operator holding the console lock; absent when nobody does. */
  panel_locked_by?: string;
  /** Warm right now (see SessionSummaryView.warm). */
  warm: boolean;
  /** Whether a turn is in flight, when that can be told; absent otherwise. */
  turn_in_flight?: boolean;
  activity: SessionActivity;
}

/** One earlier exchange line of a session, from its durable conversation record. */
export interface SessionHistoryItem {
  /** Stable per line: the record's row id and the side (`<row>:user`, `<row>:agent`). */
  id: string;
  /** Epoch ms the turn was recorded (the agent's line shares its user line's time). */
  at: number;
  who: "user" | "agent";
  /** Display name when the record has one (the Slack user name of a user line). */
  name?: string;
  /** Redacted text. */
  text: string;
}

/**
 * GET /panel/api/sessions/:id/history?cursor&limit: earlier turns, oldest
 * first. `nextCursor` loads the page before this one; null on the first page.
 * `note` says why there is no history to show (memory off or remote), so the
 * console can say so instead of an empty list.
 */
export interface SessionHistoryResponse {
  items: SessionHistoryItem[];
  nextCursor: string | null;
  note?: string;
}

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";

/** Body of POST /panel/api/sessions/:id/control. `reset` and `mode` are superadmin only. */
export type SessionControlRequest =
  | { action: "stop" | "reset" | "unlock-1on1" }
  | { action: "model"; model: string }
  | { action: "mode"; mode: PermissionMode };

export interface SessionControlResponse {
  ok: true;
  session: SessionRowView | null;
}

/** POST /panel/api/sessions/:id/chat (202). 409 `{ error, owner? }` when another operator holds the lock. */
export interface SessionChatResponse {
  ok: true;
  locked_by?: string;
}

/** POST /panel/api/sessions/:id/lock. 409 `{ error, owner }` when held by someone else. */
export interface SessionLockResponse {
  ok: true;
  locked_by: string;
  ttl_ms: number;
}

/** POST /panel/api/sessions/:id/heartbeat: 200 when still held, 409 `{ ok: false }` when lost. */
export interface SessionHeartbeatResponse {
  ok: boolean;
  ttl_ms: number;
}

export interface SessionReleaseResponse {
  ok: true;
  released: boolean;
}

/** POST /panel/api/sessions/:id/force-release (superadmin): the caller now holds the lock. */
export interface SessionForceReleaseResponse {
  ok: true;
  owner: string;
  displaced?: string;
}

export interface SessionUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalInput: number;
  contextWindow: number;
  pctUsed: number;
  remaining: number;
}

/**
 * One frame of GET /panel/api/sessions/:id/events (text/event-stream): the
 * agent's events as they happen, `id:` set to the stream entry id. The stream
 * ends with a named `session-expired` event when the access token runs out;
 * refresh and reconnect with `?lastId=` to continue without a gap.
 */
export type SessionEvent =
  | { type: "assistantText"; sessionId: string; text: string; autoEvolve?: boolean }
  // `toolUseId` pairs a result with its call; older events have none, and an
  // older result's `tool` is "".
  | { type: "toolCall"; sessionId: string; tool: string; input: unknown; toolUseId?: string; autoEvolve?: boolean }
  | { type: "toolResult"; sessionId: string; tool: string; result: unknown; toolUseId?: string; autoEvolve?: boolean }
  | { type: "thinking"; sessionId: string; text: string; autoEvolve?: boolean }
  | { type: "turnStart"; sessionId: string }
  | { type: "done"; sessionId: string; autoEvolve?: boolean }
  | { type: "error"; sessionId: string; error: string; code?: string; jobId?: string }
  | { type: "tokenUsage"; sessionId: string; snapshot: SessionUsageSnapshot }
  | { type: "compacting"; sessionId: string; trigger: "manual" | "auto" }
  // A Slack message delivered to the session (text redacted). Display only:
  // the model gets the message through its turn, never through this event.
  | { type: "userMessage"; sessionId: string; userId: string; userName?: string; text: string; at: number };

// --- Audit ------------------------------------------------------------------

export type AuditActorKind = "slack_user" | "operator" | "agent" | "system";

export interface AuditEventView {
  /** Time sortable; also the cursor. */
  id: string;
  tenantId?: string;
  persona?: string | null;
  at: number;
  actorKind: AuditActorKind | string;
  actorId: string;
  /** Dotted verb, e.g. `gate.permission.decided`, `grant.created`. */
  action: string;
  targetKind?: string | null;
  targetId?: string | null;
  decision?: string | null;
  sessionId?: string | null;
  channelId?: string | null;
  threadTs?: string | null;
  summary: string;
  details: Record<string, unknown>;
}

/** GET /panel/api/audit and GET /panel/api/sessions/:id/audit. Newest first. */
export interface AuditPageResponse {
  items: AuditEventView[];
  /** Pass back as `cursor` for the next (older) page; null on the last page. */
  nextCursor: string | null;
}

// --- Memory (read-only) -----------------------------------------------------

/** Store kinds, from the brain source naming. `other` is a source outside that
 *  naming (the brain's own `default`). */
export type MemoryStoreKind = "agent" | "shared" | "public" | "personal" | "profile" | "library" | "other";

export interface MemoryStoreView {
  id: string;
  kind: MemoryStoreKind;
  label: string;
  pageCount: number;
}

export interface MemoryStoresResponse {
  stores: MemoryStoreView[];
}

export interface MemoryPageSummaryView {
  slug: string;
  type: string;
  title: string;
  updatedAt: number | null;
}

/** GET /panel/api/memory/stores/:id/pages, ordered by slug. */
export interface MemoryPagesResponse {
  items: MemoryPageSummaryView[];
  /** Opaque; pass back as `cursor`. Null on the last page. */
  nextCursor: string | null;
}

export interface MemoryPageLinkView {
  to: string;
  type: string;
  context: string;
}

/** GET /panel/api/memory/pages?store=&slug= */
export interface MemoryPageResponse {
  store: string;
  slug: string;
  type: string;
  title: string;
  content: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  links: MemoryPageLinkView[];
  createdAt: number | null;
  updatedAt: number | null;
}

// --- Environments, console roles, overview ----------------------------------

export interface NodeView {
  id: string;
  /** Last heartbeat (epoch ms), or null when it could not be read. */
  lastSeen: number | null;
}

export interface NodePoolView {
  /** Node label. A label a persona runs on with no live node has `nodes: []`. */
  label: string;
  nodes: NodeView[];
}

/** A person's saved execution environment. Never carries config, secrets or endpoints. */
export interface PersonalEnvironmentView {
  id: string;
  owner: { teamId: string; userId: string };
  name: string;
  kind: string;
  defaultDir: string | null;
  createdAt: number;
}

/** GET /panel/api/environments */
export interface EnvironmentsResponse {
  /** Empty in a single-process deployment or without Redis. */
  nodePools: NodePoolView[];
  personas: Array<{ name: string; runsOn: string }>;
  personal: PersonalEnvironmentView[];
}

/** GET /panel/api/console-roles: the console's email allowlist (read-only). */
export interface ConsoleRolesResponse {
  superadmin: string[];
  operator: string[];
}

/** GET /panel/api/overview */
export interface OverviewResponse {
  counts: {
    agents: number;
    /** Active sessions: warm right now (in the node registry, or live in this
     *  process on a single-process deployment), not the stored status. */
    liveSessions: number;
    /** Permission, approval and connect cards waiting on a decision. */
    pendingApprovals: number;
    auditEvents24h: number;
  };
  /** The 10 most recent audit events, newest first. */
  recentAudit: AuditEventView[];
}
