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
  /** `#name` of `channelId` when the gateway could resolve it. Titles and triggers already use it. */
  channelLabel?: string;
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
  /** Display name of the subject (`#team`, `Jane Doe`, a workspace name) and of `channelId`, when resolvable. */
  subjectLabel?: string;
  channelLabel?: string;
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
  /** Display name of the subject (`#team`, `Jane Doe`, a workspace name), when resolvable. */
  subjectLabel?: string;
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
  /** See {@link SessionModelView}. */
  effective_model: string | null;
  model_source: ModelSource;
  /** The Slack channel's display label (`#name`, `DM with Jane Doe`, `DM`) when the gateway could resolve it. */
  channel_label?: string;
  /** The chat surface the conversation is on. */
  surface: SurfaceId;
}

/**
 * Where a session's shown model comes from: the session row (`session`), the
 * agent's configured model (`agent`), or the deployment default
 * (`deployment`, `effective_model` is SLAUDE_MODEL when set, else null).
 */
export type ModelSource = "session" | "agent" | "deployment";

/**
 * `working`: a turn is in flight. `warm`: the CLI process is up and waiting
 * for the next message. `idle`: nothing is running (a stored `running` row
 * that no node or process holds is idle). `error`: the stored status says the
 * session failed and nothing holds it.
 */
export type SessionActivity = "working" | "warm" | "idle" | "error";

/** GET /panel/api/sessions?persona&status&limit&offset, newest first. `limit` defaults to 50. */
export interface SessionsResponse {
  sessions: SessionSummaryView[];
  /** Pass back as `offset` for the next (older) page; null on the last page. */
  nextOffset: number | null;
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
  effective_model: string | null;
  model_source: ModelSource;
  /** The Slack channel's display label, when it could be resolved. */
  channel_label?: string;
  /** The chat surface the conversation is on. */
  surface: SurfaceId;
}

/** One earlier exchange line of a session, from its durable conversation record. */
export interface SessionHistoryItem {
  /** Stable per line: the record's row id and the side (`<row>:user`, `<row>:agent`). */
  id: string;
  /**
   * Epoch ms. A user line carries its Slack message time when the record has
   * it; an agent line carries the time the turn was recorded (just after the
   * reply). When only the record's day is known, `dateOnly` is set and the
   * console shows the date, not a clock time.
   */
  at: number;
  dateOnly?: boolean;
  who: "user" | "agent";
  /** Display name when the record has one (the Slack user name of a user line). */
  name?: string;
  /** Redacted text. */
  text: string;
  /** The surface the conversation is on (where a user line was said). */
  surface: SurfaceId;
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
  /** Slack user id -> display name for the `<@U…>` mentions in these items that resolved. */
  users?: Record<string, string>;
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
  // `surface` says where it was said; events written before it existed have none (read as Slack).
  | { type: "userMessage"; sessionId: string; userId: string; userName?: string; text: string; at: number; surface?: SurfaceId };

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
  /** Display label of `channelId` (`#name`, `DM with ...`) when resolvable. */
  channelLabel?: string;
  /** Display label of the target when it is a channel and resolvable. */
  targetLabel?: string;
  /** The surface of the conversation the event happened in, when it has one (a channel or session). */
  surface?: SurfaceId;
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

// --- Surfaces -----------------------------------------------------------------

/**
 * The chat surface a conversation lives on. Every session is on Slack today;
 * the console turns the id into words and icons from its own registry
 * (src/web/console/lib/surfaces.ts), so a new surface is an entry there.
 */
export type SurfaceId = "slack" | (string & {});

// --- Resources: skills (read-only, plus retire and restore) -------------------

/**
 * Where a skill comes from:
 * - `built-in`: slaude's own `slaude:*` skills, part of every session;
 * - `installed`: placed in a skills root by the dependency manifest
 *   (slaude.json and slaude.lock), seeded from the release, or put there by an operator;
 * - `plugin`: a Claude Code plugin installed from the manifest and mounted into every session;
 * - `agent-authored`: written by the agent itself with write_skill.
 */
export type SkillSourceKind = "built-in" | "installed" | "plugin" | "agent-authored";

export type SkillStatus = "active" | "retired";

/** Where one skill came from, as far as the runtime records it. Absent fields are unknown. */
export interface SkillOrigin {
  /** The root it lives in: the shared base, one agent's own overlay, the built-in plugin, or a plugin's install path. */
  root: "base" | "agent" | "built-in" | "plugin";
  /** Installed from the manifest: the git repo, the requested ref and the pinned commit from slaude.lock. */
  repo?: string;
  ref?: string;
  commit?: string;
  /** Path of the skill inside the repo, when the manifest names one. */
  path?: string;
  /** Shipped with the slaude release and seeded into the base root at boot. */
  bundled?: boolean;
  /** In a skills root but in no lock: placed by an operator or the personas repo. */
  local?: boolean;
  /** Plugin skills: the plugin, its marketplace, version and commit. */
  plugin?: string;
  marketplace?: string;
  version?: string;
  /** Agent-authored: the agent whose root it was written to, and when (frontmatter `authored_at`). */
  authoredBy?: string;
  authoredAt?: string | null;
  /** Retired copies: when it was retired and the retired copy's id. */
  retiredAt?: number | null;
  retiredId?: string;
}

export interface SkillUsageTotals {
  uses: number;
  lastUsedAt: number | null;
  /** When usage tracking of this skill began (the earliest first sighting). */
  trackedSince: number | null;
}

export interface SkillSummaryView {
  /** Stable id for the detail route, e.g. `base:triage`, `agent:scout:triage`, `builtin:memory`, `plugin:docs:search`, `retired:default:triage-20261101T000000Z`. */
  id: string;
  slug: string;
  name: string;
  description: string;
  /** How a person or the agent invokes it (`/triage`, `slaude:memory`, `docs:search`). */
  invocation: string;
  source: SkillSourceKind;
  status: SkillStatus;
  origin: SkillOrigin;
  /** The agents that can use it now (none for a retired copy). */
  agents: string[];
  /** Summed over those agents. */
  usage: SkillUsageTotals;
  /** True when another skill with the same slug in an agent's overlay shadows this one for that agent. */
  shadowedFor?: string[];
}

/** GET /panel/api/skills */
export interface SkillsResponse {
  skills: SkillSummaryView[];
  /** Why part of the list may be missing (an unreadable lock, a failed usage read). */
  notes: string[];
}

export interface SkillFileView {
  /** Relative to the skill's directory, `/` separated. */
  path: string;
  size: number;
}

export interface SkillUsageRowView {
  agent: string;
  /** The usage key the row was counted under (slug or CLI name). */
  key: string;
  uses: number;
  lastUsedAt: number | null;
  firstSeenAt: number;
}

export interface SkillProposalView {
  id: string;
  kind: string;
  status: string;
  agent: string;
  createdAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  /** The reason the proposal or retirement gave. */
  reason: string | null;
}

/** GET /panel/api/skills/:id */
export interface SkillDetailResponse extends SkillSummaryView {
  /** Frontmatter keys as written (values as text). */
  frontmatter: Record<string, unknown>;
  /** The SKILL.md body, without frontmatter. */
  body: string;
  /** The whole SKILL.md, as written. */
  raw: string;
  files: SkillFileView[];
  /** True when the file list was cut at its limit. */
  filesTruncated: boolean;
  usageHistory: SkillUsageRowView[];
  proposals: SkillProposalView[];
  /** What a superadmin may do to it from the console. */
  actions: { retire: boolean; restore: boolean };
}

/** POST /panel/api/skills/:id/retire and /restore (superadmin). */
export interface SkillActionResponse {
  ok: true;
  /** The id the skill has now (a retired copy's id, or the live skill's). */
  id: string;
}

// --- Resources: guardrails (read-only) ---------------------------------------

/**
 * Where an effective value comes from: an environment variable, the agent's
 * soul, the persona's own config, a stored console grant, a rule the agent
 * learned from a person, or the code's default or fixed rule.
 */
export type GuardrailSource = "env" | "soul" | "persona" | "console" | "learned" | "default" | "code";

export interface GuardrailSetting {
  key: string;
  label: string;
  value: string | number | boolean | string[] | null;
  source: GuardrailSource;
  /** The variable, soul section or constant it is read from. */
  origin?: string;
  note?: string;
}

export interface GuardrailTable {
  columns: string[];
  rows: string[][];
}

export type GuardrailFamilyId =
  | "tool-permissions"
  | "approvals"
  | "admission"
  | "memory-gating"
  | "profile-guard"
  | "policy"
  | "redaction"
  | "proactive"
  | "learned-rules"
  | "wake-tools"
  | "budgets";

export interface GuardrailFamily {
  id: GuardrailFamilyId;
  title: string;
  /** One line: what it constrains. */
  summary: string;
  /** `agent`: this agent's own values; `deployment`: the same for every agent. */
  scope: "agent" | "deployment";
  /** `unavailable`: could not be read now (see note); `not-implemented`: designed, not in the code. */
  status: "active" | "unavailable" | "not-implemented";
  settings: GuardrailSetting[];
  table?: GuardrailTable;
  /** Governing prose (markdown): the soul's own section, or how the rule works. */
  text?: string;
  /** Where `text` comes from, e.g. "SOUL.md ## Proactive". */
  textSource?: string;
  note?: string;
  /** A console page with more, e.g. the agent's Access tab. */
  link?: { label: string; to: string };
}

/** GET /panel/api/guardrails?agent= */
export interface GuardrailsResponse {
  agent: string;
  families: GuardrailFamily[];
}
