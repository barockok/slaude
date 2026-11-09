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
  /** The actor's display name when the console knows one: an agent actor reads as the agent's name, not its bot user id. */
  actorLabel?: string;
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
/** One line of a memory timeline entry: a recorded turn's two sides, or a plain note. */
export interface MemoryEntryLine {
  who: "user" | "agent" | "note";
  name?: string;
  text: string;
}

/** One timeline row of a memory page (a conversation page has one per turn). */
export interface MemoryEntryView {
  id: number;
  date: string;
  /** Epoch ms the row was written, or null when only the day is known. */
  at: number | null;
  lines: MemoryEntryLine[];
}

export interface MemoryPageResponse {
  store: string;
  slug: string;
  type: string;
  title: string;
  content: string;
  timeline: string;
  /** The page's timeline rows, oldest first: at most the latest MEMORY_ENTRIES_MAX. */
  entries: MemoryEntryView[];
  /** True when older rows exist past that cap. */
  entriesCapped: boolean;
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
  /** The tracked version number; null when none is recorded (built-in and plugin skills, or before the first capture). For a retired copy: the version it had when retired. */
  currentVersion: number | null;
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
  /** The whole SKILL.md, as written, up to 256 KB (see rawTruncated). */
  raw: string;
  /** True when SKILL.md is larger than the 256 KB the console reads. */
  rawTruncated: boolean;
  /** Why SKILL.md was not read (a symlink, outside the skill directory), when it was not. */
  rawUnreadable?: string;
  files: SkillFileView[];
  /** True when the file list was cut at its limit. */
  filesTruncated: boolean;
  usageHistory: SkillUsageRowView[];
  proposals: SkillProposalView[];
  /** What a superadmin may do to it from the console. */
  actions: { retire: boolean; restore: boolean };
}

/** One recorded version of a skill, without its text. */
export interface SkillVersionView {
  version: number;
  /** sha256 over the skill's files. */
  hash: string;
  capturedAt: number;
  /** Where the skill came from when this version was captured. */
  origin: "bundled" | "installed" | "agent";
  fileCount: number;
  totalBytes: number;
  /** True when SKILL.md was larger than the 256 KB the log keeps. */
  skillMdTruncated: boolean;
}

/** GET /panel/api/skills/:id/versions (newest first). A retired copy lists only what was captured up to its retirement. */
export interface SkillVersionsResponse {
  versions: SkillVersionView[];
  /** True when older versions exist past the list limit. */
  truncated: boolean;
}

/** GET /panel/api/skills/:id/versions/:version */
export interface SkillVersionDetailResponse extends SkillVersionView {
  /** The SKILL.md text of this version, up to 256 KB. */
  skillMd: string;
}

/** POST /panel/api/skills/:id/retire and /restore (superadmin). */
export interface SkillActionResponse {
  ok: true;
  /** The id the skill has now (a retired copy's id, or the live skill's). */
  id: string;
}

// --- Agent settings: what the soul and access settings constrain (read-only) --

/**
 * Where an effective value comes from: an environment variable, the agent's
 * soul, the persona's own config, a stored console grant, a rule the agent
 * learned from a person, or the code's default or fixed rule.
 */
export type SettingsSource = "env" | "soul" | "persona" | "console" | "learned" | "default" | "code";

export interface SettingsValue {
  key: string;
  label: string;
  value: string | number | boolean | string[] | null;
  source: SettingsSource;
  /** The variable, soul section or constant it is read from. */
  origin?: string;
  note?: string;
}

export interface SettingsTable {
  columns: string[];
  rows: string[][];
}

export type SettingsFamilyId =
  | "tool-permissions"
  | "approvals"
  | "admission"
  | "memory-gating"
  | "profile-guard"
  | "redaction"
  | "proactive"
  | "learned-rules"
  | "wake-tools"
  | "budgets";

export interface SettingsFamily {
  id: SettingsFamilyId;
  title: string;
  /** One line: what it constrains. */
  summary: string;
  /** `agent`: this agent's own values; `deployment`: the same for every agent. */
  scope: "agent" | "deployment";
  /** `unavailable`: could not be read now (see note); `not-implemented`: designed, not in the code. */
  status: "active" | "unavailable" | "not-implemented";
  settings: SettingsValue[];
  table?: SettingsTable;
  /** Governing prose (markdown): the soul's own section, or how the rule works. */
  text?: string;
  /** Where `text` comes from, e.g. "SOUL.md ## Proactive". */
  textSource?: string;
  note?: string;
  /** A console page with more, e.g. the agent's Access tab. */
  link?: { label: string; to: string };
}

/**
 * Which page shows a group of settings (phase B moved them off the Guardrails
 * page, the rc.7 spec's phase 2):
 *   access         the agent's Access tab: approvals, permission cards, admission, redaction
 *   memory         the Memory page's Write rules: memory write tiers, the profile guard
 *   mandates       the agent's Mandates tab: proactive restraint and caps, wake tools, budgets
 *   learned-rules  the Mandates tab's learned rules (their own request: a brain read can time out)
 */
export type AgentSettingsGroup = "access" | "memory" | "mandates" | "learned-rules";

/** GET /panel/api/agents/:name/settings/:group */
export interface AgentSettingsResponse {
  agent: string;
  group: AgentSettingsGroup;
  families: SettingsFamily[];
}

// --- Resources: owner guardrails ---------------------------------------------

export type OwnerGuardrailSource = "file" | "git" | "console";
export type OwnerRuleOn = "tool" | "reply" | "inbound";
export type OwnerRuleAction = "deny" | "approve" | "redact" | "audit";

/** One parsed rule. `enforced`: code applies it now; `pending`: stored and shown, applied from a later release (reply rules). */
export interface OwnerGuardrailRule {
  id: string;
  on: OwnerRuleOn;
  action: OwnerRuleAction;
  message: string;
  status: "enforced" | "pending";
  tool?: string[];
  input?: string | Record<string, string>;
  text?: string;
}

export interface NamedChannel {
  id: string;
  /** `#name` when the gateway can resolve it. */
  label: string | null;
}

export interface OwnerGuardrailSummary {
  slug: string;
  name: string;
  description: string;
  /** null when the frontmatter could not be read. */
  scope: "shared" | "agents" | null;
  agents: string[];
  channels: NamedChannel[];
  /** The console switch. */
  enabled: boolean;
  /** The frontmatter's own `enabled`. */
  authorEnabled: boolean;
  /** Applies at all: switched on, readable and enabled by its author. */
  active: boolean;
  load: "always" | "on-match" | null;
  ruleCounts: { tool: number; reply: number; inbound: number };
  /** Has Guidance prose (advisory, read by the model). */
  guidance: boolean;
  /** Validation errors found (its valid rules and prose still apply). */
  errorCount: number;
  source: OwnerGuardrailSource;
  /** The text is a console override. */
  override: boolean;
  /** The override was written against an older source text. */
  behindSource: boolean;
  /** `agents:` names no agent of this deployment knows. */
  unknownAgents: string[];
  /** It applies to no agent (flagged in the list). */
  appliesToNoAgent: boolean;
  /** Agents whose always-loaded prose cap left this guardrail out. */
  skippedFor: string[];
  /** Last firing or delivery (audit), epoch ms. */
  lastFiredAt: number | null;
}

/** How strongly the deployment keeps an agent from changing its guardrails. */
export interface GuardrailThreatModel {
  db: "sqlite" | "pg";
  turnsRunOn: "this-process" | "nodes";
  /** True with Postgres or nodes: a session cannot reach the database. */
  strong: boolean;
  keySource: "master-key" | "key-file" | null;
}

/** GET /panel/api/guardrails */
export interface OwnerGuardrailsResponse {
  guardrails: OwnerGuardrailSummary[];
  /** The stored set's version (0: none stored yet). */
  version: number;
  /** Why the stored set could not be read or verified (sessions do not start), or null. */
  failure: string | null;
  threatModel: GuardrailThreatModel;
  /** Always-loaded prose cap per agent (characters). */
  proseMax: number;
  /** Whether the viewer may switch guardrails on and off. */
  canToggle: boolean;
  /** Whether the viewer may create, edit, override and delete guardrails (superadmin). */
  canEdit: boolean;
}

export interface OwnerGuardrailFiring {
  id: string;
  at: number;
  action: string;
  /** The rule id (absent for a Guidance delivery). */
  ruleId: string | null;
  agent: string | null;
  channel: NamedChannel | null;
  decision: string | null;
}

/** GET /panel/api/guardrails/:slug */
export interface OwnerGuardrailDetail extends OwnerGuardrailSummary {
  md: string;
  prose: string;
  rules: OwnerGuardrailRule[];
  errors: string[];
  triggers: { tool: string[]; inbound: string | null; channels: NamedChannel[] } | null;
  /** Resolved: every agent it applies to (shared = all, the default agent included). */
  appliesTo: { agents: string[]; channels: NamedChannel[]; everyChannel: boolean };
  firings: OwnerGuardrailFiring[];
  threatModel: GuardrailThreatModel;
  canToggle: boolean;
  /** Whether the viewer may edit, override, clear or delete it (superadmin). */
  canEdit: boolean;
  /**
   * The guardrail's revision: send it back with a write. A write against an
   * older revision is a 409 (someone else changed it first).
   */
  revision: number;
  /** Only console-created guardrails can be deleted; file and git ones can be switched off. */
  deletable: boolean;
  /** With a console override: the source text it replaces (the current synced or imported one), who wrote the override, when. */
  overrideOf: { sourceMd: string; author: string; updatedAt: number } | null;
}

/** Why a guardrail write was refused (the body of a 4xx). */
export interface GuardrailWriteError {
  error: string;
  /**
   *   invalid        an enforced rule (or the file) fails to parse (422)
   *   stale          someone changed it after it was loaded (409): reload
   *   exists         create: the name is taken (409)
   *   not-deletable  delete: a file or git guardrail (422): switch it off instead
   *   no-override    clear: it has no console override (404)
   *   integrity      the stored set does not verify (423): repair first
   */
  code?: "invalid" | "stale" | "exists" | "not-deletable" | "no-override" | "integrity";
  /** invalid: the problems that refuse the write. */
  blocking?: string[];
  /** invalid: every problem found. */
  errors?: string[];
  /** stale: the revision it has now (null: it was deleted). */
  revision?: number | null;
  /** integrity: how to repair the set. */
  hint?: string;
}

/** POST /panel/api/guardrails (create, superadmin): `{ slug, md }`. */
export interface CreateGuardrailRequest {
  slug: string;
  md: string;
}

/** PUT /panel/api/guardrails/:slug (superadmin): `{ md, revision }`. A console guardrail's own text changes; a file or git guardrail gets a console override. */
export interface EditGuardrailRequest {
  md: string;
  revision: number;
}

/** The answer to a create, edit, clear or delete. */
export interface GuardrailWriteResponse {
  ok: true;
  slug: string;
  /** What the write did. */
  change: "created" | "updated" | "override.set" | "override.cleared" | "deleted" | "unchanged";
  /** The guardrail's new revision (null once deleted). */
  revision: number | null;
  /** The stored set's version after the write. */
  version: number;
}

/** POST /panel/api/guardrails/validate: `{ slug, md }`, the editor's live check (no write). */
export interface GuardrailValidateRequest {
  slug: string;
  md: string;
}

/** The server parser's verdict on a draft GUARDRAIL.md. */
export interface GuardrailValidation {
  slug: string;
  /** Nothing refuses a save (other problems are shown, and the valid rules still apply). */
  ok: boolean;
  errors: string[];
  blocking: string[];
  name: string | null;
  description: string;
  scope: "shared" | "agents" | null;
  load: "always" | "on-match" | null;
  rules: OwnerGuardrailRule[];
  /** `agents:` names that no agent of this deployment has. */
  unknownAgents: string[];
  /** Agents it would apply to. */
  appliesTo: string[];
  /** Always-loaded prose: this draft's size, the cap, and per agent what the cap would leave out with this draft saved. */
  prose: {
    chars: number;
    max: number;
    overCap: Array<{ agent: string; chars: number; skipped: Array<{ slug: string; name: string; chars: number }> }>;
  };
}

/** POST /panel/api/guardrails/test: one event through an agent's effective guardrails, nothing recorded but a guardrail.tested row without text. */
export interface GuardrailTestRequest {
  agent: string;
  channel?: string | null;
  kind: "tool" | "reply" | "inbound";
  /** kind tool. */
  tool?: string;
  /** kind tool: the tool input as JSON text (an object). */
  input?: string;
  /** kind reply or inbound. */
  text?: string;
  /** An unsaved GUARDRAIL.md tried in place of the stored one (or added when new). */
  draft?: { slug: string; md: string } | null;
  /**
   * kind tool: the thread is bound with /remote, so the tool goes by its
   * remote alias and the builtin it stands for (a Bash rule holds for
   * mcp__remote__bash). Implied when the tool name is a remote alias.
   */
  remote?: boolean;
}

export interface GuardrailTestHit {
  slug: string;
  ruleId: string;
  action: OwnerRuleAction;
  message: string;
  oversize: boolean;
  deciding: boolean;
  draft: boolean;
}

export interface GuardrailTestResponse {
  agent: string;
  channel: string | null;
  kind: "tool" | "reply" | "inbound";
  rulesChecked: number;
  hits: GuardrailTestHit[];
  decision: { action: OwnerRuleAction; slug: string; ruleId: string; message: string; oversize: boolean } | null;
  outcome: string;
  /** A reply as it would be posted (formatted, redactions applied); absent when it would not be posted. */
  posted?: string;
  tooLarge: boolean;
  guidance: {
    always: Array<{ slug: string; name: string; chars: number }>;
    skipped: Array<{ slug: string; name: string; chars: number }>;
    delivered: Array<{ slug: string; name: string; via: "tool" | "inbound" }>;
    indexed: Array<{ slug: string; name: string }>;
    proseChars: number;
    proseMax: number;
  };
  /** `switchedOff`: the stored guardrail is switched off in the console; its draft was evaluated as on. */
  draft: { slug: string; errors: string[]; blocking: string[]; replaced: boolean; switchedOff: boolean } | null;
}

/** PUT /panel/api/guardrails/:slug/enabled */
export interface OwnerGuardrailToggleResponse {
  ok: true;
  slug: string;
  enabled: boolean;
  version: number;
}

/** GET /panel/api/agents/:name/guardrails: what applies to one agent. */
export interface AgentGuardrailsResponse {
  agent: string;
  guardrails: Array<OwnerGuardrailSummary & { via: "shared" | "agent"; channelLimited: boolean; skipped: boolean }>;
  prose: { chars: number; max: number; skipped: Array<{ slug: string; name: string; chars: number }> };
  failure: string | null;
}
