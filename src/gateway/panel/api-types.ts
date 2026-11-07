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
