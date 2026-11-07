/**
 * Panel HTTP surface (design §2 + §3 + Refinements 1 & 2). Owns every
 * `/panel/*` path: the operator REST API under `/panel/api/*` and the static
 * web app everywhere else. Built inside createGateway so it closes over the
 * live registry / pubsub / dispatch seam; mounted on the gateway Bun.serve for
 * mono / gateway roles (never node).
 *
 * Auth: every request is gated by the panel's own session cookie
 * (./auth/guard); `/panel/auth/*` is the only unauthenticated path, because it
 * is how a session is obtained. Boot guard: assertPanelConfig() in server.ts
 * refuses to start a panel that cannot authenticate.
 *
 * Control ops call the db functions directly (Refinement 1) — NOT the `/v1`
 * PATCH, which is job-token-scoped to a single session. Chat routes through the
 * gateway's unified enqueue seam (Refinement 2): the queue in the gateway role,
 * the in-process AgentManager in mono.
 *
 *   GET  /panel/api/sessions                     list ∩ warm registry
 *   GET  /panel/api/sessions/:id                 one row + lock owner + activity
 *   GET  /panel/api/sessions/:id/history         earlier turns (conversation record)
 *   GET  /panel/api/sessions/:id/events          SSE tail of events:<id>
 *   POST /panel/api/sessions/:id/chat            { text }        (acquires lock)
 *   POST /panel/api/sessions/:id/control         { action, ... }
 *   POST /panel/api/sessions/:id/lock            take control
 *   POST /panel/api/sessions/:id/heartbeat       refresh lock TTL
 *   POST /panel/api/sessions/:id/release         release control
 *   POST /panel/api/sessions/:id/force-release   steal + audit
 *   POST /panel/api/reload                       re-read persona config (superadmin)
 *   GET  /panel/api/personas                     git vs live per field (secrets reported as present/absent)
 *   GET  /panel/api/personas/:name               one persona's definition: references and presence, never values
 *   PUT|DELETE /panel/api/personas/:name/overrides/:field   runtime override (superadmin; wiped by the next git sync)
 *   POST /panel/api/personas                     runtime onboard of a non-git persona (superadmin)
 *
 * Console API (agent platform; shapes in ./api-types). Reads: any operator.
 * Mutations: superadmin, each one audited with actor_kind operator.
 *   GET    /panel/api/agents                       agents with mandate and grant counts
 *   GET    /panel/api/agents/:name                 one agent: mandates and effective grants
 *   GET    /panel/api/agents/:name/grants          effective grants (soul and console)
 *   POST   /panel/api/agents/:name/grants          store a console grant (superadmin)
 *   DELETE /panel/api/agents/:name/grants/:id      revoke a console grant (superadmin)
 *   GET    /panel/api/grants                       every unexpired console grant, with its persona
 *   GET    /panel/api/audit?persona&action&actor&session&decision&since&until&cursor&limit
 *   GET    /panel/api/sessions/:id/audit?cursor&limit
 *   GET    /panel/api/memory/stores                memory stores (brain sources) with page counts;
 *                                                  personal and profile stores are superadmin only
 *   GET    /panel/api/memory/stores/:id/pages?cursor&limit
 *   GET    /panel/api/memory/pages?store&slug      one page: content, type, tags, links
 *   GET    /panel/api/environments                 node pools, persona runsOn, personal environments (no secrets)
 *   GET    /panel/api/console-roles                the console's email allowlist (read-only, superadmin)
 *   GET    /panel/api/overview                     counts and the latest audit events
 */
import { PanelVoiceRedactor } from "./voice-redact";
import { z } from "zod";
import * as Sessions from "../../db/sessions";
import * as OneOnOne from "../../db/one-on-one";
import { endRemoteForThread } from "../core/remote-command";
import type { SessionRow } from "../../db/schema";
import type { Registry } from "../../queue/registry";
import type { PubSub } from "../../queue/pubsub";
import type { PanelLock } from "../../queue/panel-lock";
import type { LabelStatus } from "../../queue/label-status";
import { guardRequest } from "./auth/guard";
import { createAuthRoutes } from "./auth/routes";
import { audit } from "./auth/audit";
import { auditOneOnOne } from "../../audit/events";
import type { PanelRole } from "./auth/roles";
import { enumerateSessions } from "./enumerator";
import { activityOf, streamTurnInFlight, streamTurnsInFlight, type LocalSessions } from "./activity";
import { sessionHistory } from "./history";
import { redactSecrets } from "../../redact";
import { servePanelStatic } from "./static";
import { publishConfigReload } from "../core/config-reload";
import * as Personas from "../../db/personas";
import { OVERRIDE_FIELDS, type OverrideField, type DesiredPersona } from "../../persona/effective";
import { PERSONA_NAME_RE } from "../../persona/sync/payload";
import { resolveDbConfig } from "../../db/client";
import { assertHttpOnlyMcp, McpNotHttpOnlyError } from "../../persona/mcp-http-only";
import { extractSoulData, SoulExtractionError } from "../../soul/extract";
import { kbMode, kbView, mcpServersView, personaNodes, providerView, soulView, type NodeView, type PanelRole as PersonaViewRole } from "./persona-view";
import { installedKbSourceIds } from "../../knowledge/persona-kb";
import { discoverSkills } from "../../skills/loader";
import { credentialExpiries } from "../../db/mcp-credentials";
import { oauthKey } from "../../agent/mcp-oauth/store";
import * as AgentGrants from "../../db/agent-grants";
import { invalidateGrants } from "../../access/role";
import { emitAudit } from "../../audit/emit";
import { agentDetail, agentNames, agentSummaries, allConsoleGrants, consoleGrantView, environmentsView, grantViews, isAgent } from "./console-views";
import { loadRoleConfig } from "./auth/roles";
import * as PendingGates from "../../db/pending-gates";
import * as AuditEvents from "../../db/audit-events";
import { agentStoreNames, localMemoryBrowser, memoryUnavailableReason, storeLabel, type MemoryBrowser } from "../../knowledge/memory-browse";
import { agentIdSync } from "../../knowledge/agent-identity";
import { storeKind } from "../../knowledge/scope";
import { getPersonaRegistry } from "../../persona/registry";
import type {
  ConsoleRolesResponse,
  EnvironmentsResponse,
  OverviewResponse,
  MemoryPageResponse,
  MemoryPagesResponse,
  MemoryStoresResponse,
  AuditPageResponse,
  AgentDetailResponse,
  AgentGrantsResponse,
  SessionDetailResponse,
  SessionHistoryResponse,
  SessionsResponse,
  AllGrantsResponse,
  AgentsResponse,
  CreateGrantResponse,
  RevokeGrantResponse,
} from "./api-types";

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Anti-CSRF guard for state-changing requests. The panel authenticates via a
 * session cookie, which the browser attaches to ANY request to this origin —
 * including one forged by a cross-site page — so the cookie alone cannot prove
 * same-origin intent. GET/HEAD are safe (no state change).
 * For everything else we require BOTH:
 *   - a custom request header no HTML form or CORS "simple request" can set
 *     (a cross-origin fetch that sets it is forced into a preflight the panel
 *     never answers with allow-origin, so the real request is blocked); and
 *   - a non-cross-site `Sec-Fetch-Site` when the browser sends one (defence in
 *     depth for clients that omit the custom header).
 * Note `req.json()` parses `text/plain` bodies too, so content-type is not a
 * sufficient guard on its own — hence the explicit custom header.
 */
function enforceCsrf(req: Request): Response | null {
  if (req.method === "GET" || req.method === "HEAD") return null;
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "same-site" && site !== "none") {
    return json(403, { error: "cross-site request refused" });
  }
  if (req.headers.get("x-panel-csrf") !== "1") {
    return json(403, { error: "missing anti-CSRF header (x-panel-csrf)" });
  }
  return null;
}

/**
 * Actions gated to superadmin (design §Authorization). `reset` discards session
 * state unrecoverably; `mode` can set bypassPermissions, which lets the agent
 * act without gates; `force-release` steals another operator's lock.
 *
 * superadmin is a superset of operator — no action is operator-only.
 */
export const SUPERADMIN_ACTIONS: ReadonlySet<string> = new Set([
  "reload",
  "persona.override",
  "persona.create",
  "control.reset",
  "control.mode",
  "force-release",
  "grant.create",
  "grant.revoke",
  "memory.private",
  "console.roles.read",
]);

/** Returns the 403 to send, or null when the role suffices. */
export function requireSuperadmin(
  role: PanelRole,
  ctx: { action: string; operator: string; session?: string },
): Response | null {
  if (!SUPERADMIN_ACTIONS.has(ctx.action)) return null;
  if (role === "superadmin") return null;
  audit({ ...ctx, role, outcome: "denied", detail: { required: "superadmin" } });
  return json(403, { error: `action '${ctx.action}' requires the superadmin role`, required: "superadmin" });
}

const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"] as const;

const controlSchema = z
  .object({
    action: z.enum(["stop", "reset", "model", "mode", "unlock-1on1"]),
    model: z.string().min(1).optional(),
    mode: z.enum(PERMISSION_MODES).optional(),
  })
  .strict();

const chatSchema = z.object({ text: z.string().min(1) }).strict();

const createGrantSchema = z
  .object({
    subjectKind: z.enum(AgentGrants.SUBJECT_KINDS),
    subjectId: z.string().trim().min(1).max(64),
    role: z.enum(AgentGrants.GRANT_ROLES),
    deny: z.boolean().optional(),
    dmOnly: z.boolean().optional(),
    expiresAt: z.number().int().positive().nullable().optional(),
    note: z.string().max(500).nullable().optional(),
  })
  .strict();

/** zod issues as one line: `path: message; ...`. */
const issuesLine = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");

/** A time bound: epoch ms digits or an ISO 8601 date/time. */
const timeParam = z
  .string()
  .transform((v, ctx) => {
    const ms = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
    if (!Number.isFinite(ms)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be epoch ms or an ISO 8601 time" });
      return z.NEVER;
    }
    return ms;
  });
const pageParams = {
  cursor: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
};
const auditQuerySchema = z
  .object({
    persona: z.string().min(1).max(128).optional(),
    action: z.string().min(1).max(128).optional(),
    actor: z.string().min(1).max(128).optional(),
    session: z.string().min(1).max(128).optional(),
    decision: z.string().min(1).max(32).optional(),
    since: timeParam.optional(),
    until: timeParam.optional(),
    ...pageParams,
  })
  .strict();
const pageQuerySchema = z.object(pageParams).strict();
/** Turns per history page (each turn is a user line and an agent line). */
const HISTORY_PAGE = 20;
const historyQuerySchema = z
  .object({
    cursor: z.string().regex(/^\d{1,15}$/, "invalid cursor").optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

const STORE_ID_RE = /^[a-z0-9-]{1,32}$/;
/** Stores that hold one person's memory: superadmin only. */
const isPrivateStore = (id: string) => {
  const k = storeKind(id);
  return k === "personal" || k === "profile";
};
const MEMORY_PAGE_MAX = 100;
const memoryPagesQuerySchema = z
  .object({
    cursor: z.string().regex(/^\d{1,9}$/, "invalid cursor").optional(),
    limit: z.coerce.number().int().min(1).max(MEMORY_PAGE_MAX).optional(),
  })
  .strict();
const memoryPageQuerySchema = z
  .object({ store: z.string().regex(STORE_ID_RE, "invalid store id"), slug: z.string().min(1).max(512) })
  .strict();

/** Query string as an object; a repeated key keeps its last value. */
const queryOf = (url: URL) => Object.fromEntries(url.searchParams.entries());

/** What an audit row records of a stored grant. */
const grantDetails = (g: AgentGrants.AgentGrantRow) => ({
  grantId: g.id,
  subjectKind: g.subjectKind,
  subjectId: g.subjectId,
  role: g.role,
  deny: g.deny,
  dmOnly: g.dmOnly,
  expiresAt: g.expiresAt,
  note: g.note,
  createdBy: g.createdBy,
});

export interface PanelApiDeps {
  registry: Registry | null;
  pubsub: PubSub | null;
  panelLock: PanelLock | null;
  /**
   * Unified chat enqueue (Refinement 2). The gateway builds the panel envelope
   * and routes it through the queue (gateway role) or the in-process
   * AgentManager (mono). Called AFTER the active-surface lock is acquired.
   */
  chat: (session: SessionRow, text: string, operatorId: string) => Promise<void>;
  /** The gateway marks the session panel-driven (suppress Slack outbound). */
  onLockHeld?: (sessionId: string, operatorId: string, ttlMs: number) => void;
  /** The gateway resumes Slack + replays deferred inbound for the session. */
  onLockReleased?: (sessionId: string) => void | Promise<void>;
  /** The operator released a thread's 1on1 lock (remote mode already ended): reload the warm session. */
  onUnlock?: (sessionId: string) => void;
  /** SSE poll cadence (ms). Default 300. */
  eventsPollMs?: number;
  /** Strict soul extraction for runtime persona changes. Default: the real extractor. */
  extractSoul?: (text: string) => Promise<unknown>;
  /** Node label status (node labels spec §4.7) for GET /panel/api/labels.
   *  Absent or null (mono: no node queue) = 503. */
  labels?: (() => Promise<LabelStatus[]>) | null;
  /** Installed `kb-*` source ids, for the persona view. Default: what
   *  $SLAUDE_HOME/knowledge holds (installedKbSourceIds). */
  installedKbSources?: () => string[];
  /** Where turns run: `gateway` (on nodes, the node queue) or `mono` (this
   *  process). Decides how the persona view reports a persona's stdio MCP
   *  servers. Default `gateway`. */
  role?: PersonaViewRole;
  /** Memory store browsing. Default: the local brain (when it is enabled and local). */
  memory?: MemoryBrowser;
  /** Mono: in-process session liveness (the AgentManager). Absent in the
   *  gateway role, where the warm registry and the event stream say it. */
  local?: LocalSessions | null;
}

export interface PanelApi {
  /** Handle a request; null when the path is not under /panel (caller falls through). */
  fetch(req: Request): Promise<Response | null>;
}

export function createPanelApi(deps: PanelApiDeps): PanelApi {
  const pollMs = deps.eventsPollMs ?? 300;
  const authRoutes = createAuthRoutes();
  const extractSoul = deps.extractSoul ?? ((t: string) => extractSoulData(t, { strict: true }));
  const installedKbSources = deps.installedKbSources ?? installedKbSourceIds;
  const panelRole = deps.role ?? "gateway";

  /** Warm sessions: in this process (mono) or in the node registry (gateway). */
  async function warmCount(): Promise<number> {
    if (deps.local) return deps.local.count();
    if (!deps.registry) return 0;
    try {
      return await deps.registry.countWarm();
    } catch {
      return 0;
    }
  }

  /** Whether a session is warm, and whether a turn is in flight when that can be told. */
  async function liveness(row: SessionRow): Promise<{ warm: boolean; inFlight: boolean | undefined }> {
    if (deps.local) {
      const warm = deps.local.isWarm(row.id);
      return { warm, inFlight: warm ? deps.local.turnInFlight(row.id) : false };
    }
    let warm = false;
    try {
      const loc = deps.registry ? ((await deps.registry.lookupMany([row.id]))[0] ?? null) : null;
      warm = !!loc && loc.fresh;
    } catch {
      /* unknown: cold */
    }
    return { warm, inFlight: warm ? await streamTurnInFlight(deps.pubsub, row.id) : undefined };
  }

  async function handleEvents(req: Request, sessionId: string, expMs: number): Promise<Response> {
    if (!deps.pubsub) return json(503, { error: "event stream unavailable (no Redis)" });
    const pubsub = deps.pubsub;
    const url = new URL(req.url);
    let lastId = req.headers.get("last-event-id") || url.searchParams.get("lastId") || undefined;
    // Voice capability URLs (secret paths) are masked in every event sent; the
    // backlog teaches the redactor URLs from events this tail does not replay.
    const voice = new PanelVoiceRedactor();
    try {
      const backlog = await pubsub.readEvents(sessionId);
      for (const e of backlog) voice.learn(e.event);
      // Skip backlog: seed from the newest entry so the operator sees live
      // events, not a replay of earlier turns (dispatch follower pattern).
      if (!lastId) lastId = backlog.at(-1)?.id;
    } catch {
      /* stream may not exist yet — start from the beginning */
    }
    const encoder = new TextEncoder();
    let closed = false;
    req.signal?.addEventListener("abort", () => {
      closed = true;
    });
    const stream = new ReadableStream({
      async start(controller) {
        const send = (chunk: string) => {
          try {
            controller.enqueue(encoder.encode(chunk));
            return true;
          } catch {
            closed = true;
            return false;
          }
        };
        send(": open\n\n");
        try {
          while (!closed) {
            try {
              for (const entry of await pubsub.readEvents(sessionId, lastId)) {
                lastId = entry.id;
                // TODO(trim-gap): readEvents silently skips entries trimmed by
                // the stream cap (events:<id> is MAXLEN ~1000). On a detected
                // gap the durable SDK transcript on the RWX volume is the
                // fallback source of record; wiring that read path is a
                // separate follow-up — the live tail itself is complete here.
                if (!send(`id: ${entry.id}\ndata: ${JSON.stringify(voice.scrub(entry.event))}\n\n`)) break;
              }
            } catch (e) {
              console.error(`[panel] SSE read failed session=${sessionId}:`, e);
            }
            if (closed) break;
            if (Date.now() >= expMs) {
              // The tail must not outlive the access token that authorized it.
              // A failed send just means the client hung up first — either way
              // this stream is done.
              if (!send(`event: session-expired\ndata: {}\n\n`)) closed = true;
              break;
            }
            // Heartbeat comment keeps intermediaries from closing an idle stream.
            if (!send(": ping\n\n")) break;
            await sleep(pollMs);
          }
        } finally {
          try {
            controller.close();
          } catch {
            /* already closed by the client */
          }
        }
      },
      cancel() {
        closed = true;
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  }

  async function handleControl(req: Request, row: SessionRow, operatorId: string, role: PanelRole): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "malformed JSON body" });
    }
    const parsed = controlSchema.safeParse(body);
    if (!parsed.success) {
      return json(400, { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    }
    const { action, model, mode } = parsed.data;
    const denied = requireSuperadmin(role, {
      action: `control.${action}`,
      operator: operatorId,
      session: row.id,
    });
    if (denied) return denied;
    switch (action) {
      case "stop": {
        if (!deps.pubsub) return json(503, { error: "stop unavailable (no Redis)" });
        await deps.pubsub.publishAbort(row.id);
        break;
      }
      case "reset":
        await Sessions.clearStarted(row.id);
        break;
      case "model":
        if (!model) return json(400, { error: "action 'model' requires a model" });
        await Sessions.setModel(row.id, model);
        break;
      case "mode":
        if (!mode) return json(400, { error: "action 'mode' requires a mode" });
        await Sessions.setPermissionMode(row.id, mode);
        break;
      case "unlock-1on1": {
        if (!row.slack_channel_id || !row.slack_thread_ts) {
          return json(400, { error: "session has no Slack thread to unlock" });
        }
        const held = await OneOnOne.find(row.slack_channel_id, row.slack_thread_ts);
        // Unlocking must also end remote mode: a surviving target would come back to
        // life on the next lock by the same user.
        await endRemoteForThread(row.slack_channel_id, row.slack_thread_ts, { sessionId: row.id, userMachineOnly: true });
        await OneOnOne.unlock(row.slack_channel_id, row.slack_thread_ts);
        // One row for this control, and only when a lock was released.
        if (held) {
          auditOneOnOne("one_on_one.unlocked", {
            operator: operatorId, persona: row.persona_id, sessionId: row.id,
            channelId: row.slack_channel_id, threadTs: row.slack_thread_ts,
            lockedUser: held.locked_user, via: "panel",
          });
        }
        // The unlock has applied; a failed reload must not turn it into a 500.
        try {
          deps.onUnlock?.(row.id);
        } catch {
          console.error(`[panel] reload after unlock failed session=${row.id}`);
        }
        break;
      }
    }
    // unlock-1on1 is recorded above as one_on_one.unlocked (one row, not two).
    if (action !== "unlock-1on1") {
      audit({ action: `control.${action}`, operator: operatorId, role, session: row.id, detail: { model, mode } });
    }
    const fresh = await Sessions.findById(row.id);
    return json(200, { ok: true, session: fresh });
  }

  async function fetch(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (url.pathname !== "/panel" && !url.pathname.startsWith("/panel/")) return null;

    const seg = url.pathname.split("/").filter(Boolean); // ["panel", ...]

    // Auth routes are the only unauthenticated paths — they are how a session
    // is obtained. CSRF still applies to their mutating methods.
    if (seg[1] === "auth") {
      const csrf = enforceCsrf(req);
      if (csrf) return csrf;
      try {
        const res = await authRoutes.handle(req, seg);
        if (res) return res;
      } catch (e) {
        // These routes are unauthenticated and talk to the provider: a down or
        // misconfigured IdP is an ordinary condition any caller can trigger.
        // Answer with a flat 502 rather than letting the throw reach Bun.serve,
        // which has no error handler and would render a stack trace.
        console.error(`[panel] auth route ${url.pathname} failed:`, e);
        return json(502, { error: "authentication is temporarily unavailable" });
      }
      return json(404, { error: "not found" });
    }

    // Static web app: any /panel path that is not the API.
    if (seg[1] !== "api") {
      const auth = guardRequest(req, { html: true });
      if (!auth.ok) return auth.response;
      return (await servePanelStatic(url.pathname)) ?? json(404, { error: "not found" });
    }

    const auth = guardRequest(req, { html: false });
    if (!auth.ok) return auth.response;
    const { operatorId, role } = auth;

    // CSRF: block forged cross-site state changes before any mutating handler.
    const csrf = enforceCsrf(req);
    if (csrf) return csrf;

    try {
      // POST /panel/api/reload — re-read persona configuration without a restart.
      // The persona registry is memoized at boot on the gateway AND on every
      // node, so adding an agent otherwise means restarting all of them.
      if (seg.length === 3 && seg[2] === "reload") {
        if (req.method !== "POST") return json(405, { error: "method not allowed" });
        const denied = requireSuperadmin(role, { action: "reload", operator: operatorId });
        if (denied) return denied;
        const tenantId = url.searchParams.get("tenant") ?? "default";
        const result = await publishConfigReload(deps.pubsub, tenantId);
        audit({ action: "reload", operator: operatorId, role, outcome: "ok", detail: { tenantId, ...result } });
        return json(200, { tenant: tenantId, ...result });
      }

      // GET /panel/api/labels — read-only, any authenticated operator: per node
      // label in use, its live nodes, waiting jobs and whether it is unserved.
      if (seg.length === 3 && seg[2] === "labels") {
        if (req.method !== "GET") return json(405, { error: "method not allowed" });
        if (!deps.labels) return json(503, { error: "label status unavailable (no node queue)" });
        return json(
          200,
          (await deps.labels()).map((s) => ({ label: s.label, liveNodes: s.liveNodes, waiting: s.waiting, unserved: s.unserved })),
        );
      }

      // --- Agents: mandates and grants (console). Reads for any operator; grant
      // changes are superadmin only and audited as grant.created / grant.revoked.
      if (seg[2] === "agents") {
        const liveness = { role: panelRole, registry: deps.registry };
        if (seg.length === 3) {
          if (req.method !== "GET") return json(405, { error: "method not allowed" });
          return json(200, { agents: await agentSummaries(liveness) } satisfies AgentsResponse);
        }
        let name: string;
        try { name = decodeURIComponent(seg[3]!); } catch { return json(422, { error: "invalid agent name" }); }
        if (!PERSONA_NAME_RE.test(name)) return json(422, { error: "invalid agent name" });
        if (!isAgent(name)) return json(404, { error: `no agent named '${name}'` });

        // GET /panel/api/agents/:name
        if (seg.length === 4) {
          if (req.method !== "GET") return json(405, { error: "method not allowed" });
          return json(200, (await agentDetail(name, liveness)) satisfies AgentDetailResponse);
        }

        if (seg[4] !== "grants" || seg.length > 6) return json(404, { error: "not found" });

        // GET|POST /panel/api/agents/:name/grants
        if (seg.length === 5) {
          if (req.method === "GET") return json(200, { grants: await grantViews(name) } satisfies AgentGrantsResponse);
          if (req.method !== "POST") return json(405, { error: "method not allowed" });
          const denied = requireSuperadmin(role, { action: "grant.create", operator: operatorId });
          if (denied) return denied;
          let body: unknown;
          try { body = await req.json(); } catch { return json(400, { error: "malformed JSON body" }); }
          const parsed = createGrantSchema.safeParse(body);
          if (!parsed.success) return json(400, { error: issuesLine(parsed.error) });
          const b = parsed.data;
          if (b.expiresAt != null && b.expiresAt <= Date.now()) return json(400, { error: "expiresAt must be in the future" });
          let row: AgentGrants.AgentGrantRow;
          try {
            row = await AgentGrants.create({
              tenantId: "default",
              persona: name,
              subjectKind: b.subjectKind,
              subjectId: b.subjectId,
              role: b.role,
              deny: b.deny,
              dmOnly: b.dmOnly,
              createdBy: operatorId,
              expiresAt: b.expiresAt ?? null,
              note: b.note ?? null,
            });
          } catch (e) {
            // The repository's own combination rules (e.g. a channel subject can
            // only be a member): a request error, said plainly.
            if (e instanceof Error && e.message.startsWith("agent grant: ")) {
              return json(400, { error: e.message.slice("agent grant: ".length) });
            }
            throw e;
          }
          invalidateGrants(name);
          const grant = consoleGrantView(row);
          emitAudit({
            tenantId: "default",
            persona: name,
            actorKind: "operator",
            actorId: operatorId,
            action: "grant.created",
            targetKind: "grant",
            targetId: row.id,
            summary: `${row.deny ? "deny" : row.role} for ${row.subjectKind} ${row.subjectId}`,
            details: { ...grantDetails(row), operatorRole: role },
          });
          return json(201, { grant } satisfies CreateGrantResponse);
        }

        // DELETE /panel/api/agents/:name/grants/:id
        if (req.method !== "DELETE") return json(405, { error: "method not allowed" });
        const denied = requireSuperadmin(role, { action: "grant.revoke", operator: operatorId });
        if (denied) return denied;
        let id: string;
        try { id = decodeURIComponent(seg[5]!); } catch { return json(404, { error: "no such grant" }); }
        const row = await AgentGrants.findById(id);
        // A grant of another agent is not this agent's: same answer as none.
        if (!row || row.persona !== name) return json(404, { error: "no such grant on this agent" });
        // revoke() fires the repository's change hook, which clears the
        // in-process grant cache (role.ts registers it at import).
        if (!(await AgentGrants.revoke(id))) return json(404, { error: "no such grant on this agent" });
        emitAudit({
          tenantId: "default",
          persona: name,
          actorKind: "operator",
          actorId: operatorId,
          action: "grant.revoked",
          targetKind: "grant",
          targetId: row.id,
          summary: `revoked ${row.deny ? "deny" : row.role} for ${row.subjectKind} ${row.subjectId}`,
          details: { ...grantDetails(row), operatorRole: role },
        });
        return json(200, { ok: true } satisfies RevokeGrantResponse);
      }

      // GET /panel/api/grants: every console grant across agents, for the
      // Access page. Read-only, any operator.
      if (seg.length === 3 && seg[2] === "grants") {
        if (req.method !== "GET") return json(405, { error: "method not allowed" });
        return json(200, { grants: await allConsoleGrants() } satisfies AllGrantsResponse);
      }

      // GET /panel/api/audit: the durable audit trail, newest first. Read-only,
      // any authenticated operator.
      if (seg.length === 3 && seg[2] === "audit") {
        if (req.method !== "GET") return json(405, { error: "method not allowed" });
        const q = auditQuerySchema.safeParse(queryOf(url));
        if (!q.success) return json(400, { error: issuesLine(q.error) });
        const { persona, action, actor, session, decision, since, until, cursor, limit } = q.data;
        const page = await AuditEvents.list(
          { persona, action, actorId: actor, sessionId: session, decision, since, until },
          { cursor, limit },
        );
        return json(200, page satisfies AuditPageResponse);
      }

      // GET /panel/api/environments: where agents run. Read-only, any operator.
      if (seg.length === 3 && seg[2] === "environments") {
        if (req.method !== "GET") return json(405, { error: "method not allowed" });
        return json(200, (await environmentsView({ role: panelRole, registry: deps.registry })) satisfies EnvironmentsResponse);
      }

      // GET /panel/api/console-roles: the allowlist file (or env lists), for
      // superadmins only (it lists every console user's email). It is edited
      // where it lives, never here.
      if (seg.length === 3 && seg[2] === "console-roles") {
        if (req.method !== "GET") return json(405, { error: "method not allowed" });
        const denied = requireSuperadmin(role, { action: "console.roles.read", operator: operatorId });
        if (denied) return denied;
        const cfg = loadRoleConfig();
        return json(200, { superadmin: [...cfg.superadmin], operator: [...cfg.operator] } satisfies ConsoleRolesResponse);
      }

      // GET /panel/api/overview: headline counts and the latest audit events.
      if (seg.length === 3 && seg[2] === "overview") {
        if (req.method !== "GET") return json(405, { error: "method not allowed" });
        const now = Date.now();
        const [liveSessions, pendingApprovals, auditEvents24h, recent] = await Promise.all([
          // Warm sessions, not stored `running` rows (which outlive their node).
          warmCount(),
          PendingGates.countPending(now),
          AuditEvents.countSince(now - 24 * 60 * 60 * 1000),
          AuditEvents.list({}, { limit: 10 }),
        ]);
        return json(200, {
          counts: { agents: agentNames().length, liveSessions, pendingApprovals, auditEvents24h },
          recentAudit: recent.items,
        } satisfies OverviewResponse);
      }

      // --- Memory: brain sources and their pages, read-only. Personal (`user-*`)
      // and profile (`profile-*`) stores hold what one person told an agent:
      // superadmin only, hidden from an operator's store list, and every page
      // a superadmin opens in one is audited (memory.page.viewed, no content).
      // Other stores: any operator, not audited, like every other panel read.
      if (seg[2] === "memory") {
        if (req.method !== "GET") return json(405, { error: "method not allowed" });
        const unavailable = memoryUnavailableReason();
        if (unavailable) return json(503, { error: unavailable });
        const memory = deps.memory ?? localMemoryBrowser();

        // GET /panel/api/memory/stores
        if (seg.length === 4 && seg[3] === "stores") {
          const r = getPersonaRegistry();
          const agents = agentStoreNames([
            { name: "default", agentId: agentIdSync() },
            ...r.list().map((p) => ({ name: p.name, agentId: p.slackUserId })),
          ]);
          const stores = (await memory.stores())
            .filter((s) => role === "superadmin" || !isPrivateStore(s.id))
            .map((s) => ({ ...s, label: storeLabel(s.id, agents) }));
          return json(200, { stores } satisfies MemoryStoresResponse);
        }

        // GET /panel/api/memory/stores/:id/pages
        if (seg.length === 6 && seg[3] === "stores" && seg[5] === "pages") {
          const store = seg[4]!;
          if (!STORE_ID_RE.test(store)) return json(422, { error: "invalid store id" });
          const q = memoryPagesQuerySchema.safeParse(queryOf(url));
          if (!q.success) return json(400, { error: issuesLine(q.error) });
          if (isPrivateStore(store)) {
            const denied = requireSuperadmin(role, { action: "memory.private", operator: operatorId });
            if (denied) return denied;
          }
          const offset = Number(q.data.cursor ?? 0);
          const limit = q.data.limit ?? 50;
          // One row past the page says whether there is a next one.
          const rows = await memory.pages(store, { offset, limit: limit + 1 });
          const items = rows.slice(0, limit);
          return json(200, {
            items,
            nextCursor: rows.length > limit ? String(offset + limit) : null,
          } satisfies MemoryPagesResponse);
        }

        // GET /panel/api/memory/pages?store=&slug=
        if (seg.length === 4 && seg[3] === "pages") {
          const q = memoryPageQuerySchema.safeParse(queryOf(url));
          if (!q.success) return json(400, { error: issuesLine(q.error) });
          const priv = isPrivateStore(q.data.store);
          if (priv) {
            const denied = requireSuperadmin(role, { action: "memory.private", operator: operatorId });
            if (denied) return denied;
          }
          const page = await memory.page(q.data.store, q.data.slug);
          if (!page) return json(404, { error: "no such page in that store" });
          if (priv) {
            emitAudit({
              tenantId: "default",
              actorKind: "operator",
              actorId: operatorId,
              action: "memory.page.viewed",
              targetKind: "memory_page",
              targetId: `${page.store}/${page.slug}`,
              summary: `viewed a ${storeKind(page.store)} memory page`,
              details: { store: page.store, slug: page.slug, storeKind: storeKind(page.store), operatorRole: role },
            });
          }
          return json(200, page satisfies MemoryPageResponse);
        }
        return json(404, { error: "not found" });
      }

      // --- Runtime persona changes. Git is the source of truth; these are for
      // quick experiments and every sync from git wipes them. CSRF already ran
      // above, before any route. Tenant is always "default".
      if (seg[2] === "personas") {
        // The persona tables are Postgres-only: say so instead of a 500.
        if (resolveDbConfig().dialect === "sqlite") return json(409, { error: Personas.PERSONA_SYNC_NEEDS_PG });
        const tenant = "default";
        const status = (e: unknown): Response | null => {
          if (e instanceof Personas.PersonaNotFoundError) return json(404, { error: e.message });
          if (
            e instanceof Personas.NotManagedError ||
            e instanceof Personas.NameTakenError ||
            e instanceof Personas.IdentityTakenError
          ) return json(409, { error: e.message });
          if (e instanceof SoulExtractionError) {
            // The cause can carry provider response text: server log only,
            // truncated, as the pipeline's sync does.
            console.error(`[panel] soul extraction failed: ${e.message.slice(0, 200)}`);
            return json(502, { error: "soul extraction failed" });
          }
          return null;
        };
        const readBody = async (): Promise<Record<string, unknown> | null> => {
          const b = await req.json().catch(() => null);
          return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
        };

        // GET /panel/api/personas — read-only, like sessions: any authenticated operator.
        if (seg.length === 3 && req.method === "GET") {
          const live = await Personas.effectivePersonas(tenant, { includeTombstoned: true });
          const desired = new Map((await Personas.desiredPersonas(tenant, { includeTombstoned: true })).map((d) => [d.name, d]));
          const presence = (v: unknown) => (v != null ? "present" : "absent");
          return json(200, {
            revision: (await Personas.syncState(tenant))?.revision ?? null,
            // A sync can commit between the two reads; skip a persona the
            // desired read does not know yet (it shows on the next read).
            personas: live.flatMap((p) => {
              const d = desired.get(p.name);
              if (!d) return [];
              const overridden = (f: OverrideField) => p.overridden.includes(f);
              return {
                name: p.name,
                origin: p.origin,
                tombstoned: p.tombstonedAt !== null,
                slackUserId: p.slackUserId,
                userToken: presence(p.userToken),
                // Where the persona runs (node labels spec §4.5); git-only, never overridden.
                runsOn: p.runsOn ?? null,
                // Knowledge scope summary (WS-C §4.1); the ids are on the detail route.
                kb: { mode: kbMode(p.kbSources) },
                fields: {
                  soul: { git: d.soulMd, live: p.soulMd, overridden: overridden("soul") },
                  model: { git: d.model, live: p.model, overridden: overridden("model") },
                  mcp: { git: presence(d.mcp), live: presence(p.mcp), overridden: overridden("mcp") },
                },
              };
            }),
          });
        }

        // GET /panel/api/personas/:name — one persona's definition (WS-C §4.4.1).
        // Read-only, any authenticated operator. References and presence only:
        // persona-view.ts says what is never shown. Not audited, like every
        // other panel read, and nothing from the persona is logged.
        if (seg.length === 4) {
          if (req.method !== "GET") return json(405, { error: "method not allowed" });
          let name: string;
          try { name = decodeURIComponent(seg[3]!); } catch { return json(422, { error: "invalid persona name" }); }
          if (!PERSONA_NAME_RE.test(name)) return json(422, { error: "invalid persona name" });
          const one = await Personas.personaByName(tenant, name, { includeTombstoned: true });
          if (!one) return json(404, { error: `no persona named '${name}'` });
          const { effective: p, desired: d } = one;
          // Whether the agent holds an OAuth credential per server: expiries
          // only, nothing decrypted.
          const held = await credentialExpiries({ kind: "agent", tenant, persona: name });
          let nodes: NodeView[] | null;
          try {
            nodes = await personaNodes(deps.registry, p.runsOn);
          } catch (e) {
            // The node list is a live read; the definition stays useful without it.
            console.error(`[panel] node lookup for a persona view failed: ${e instanceof Error ? e.name : typeof e}`);
            nodes = null;
          }
          const overridden = (f: OverrideField) => p.overridden.includes(f);
          return json(200, {
            name: p.name,
            origin: p.origin,
            tombstoned: p.tombstonedAt !== null,
            slackUserId: p.slackUserId,
            soul: soulView(p.soulMd, overridden("soul")),
            model: { git: d.model, live: p.model, overridden: overridden("model") },
            runsOn: p.runsOn ?? null,
            provider: providerView(p.provider),
            mcp: mcpServersView(p.mcp, { role: panelRole, agentExpiry: (server, cfg) => held[oauthKey(server, cfg)] ?? null }),
            kb: kbView(p.kbSources, installedKbSources()),
            skills: discoverSkills(name)
              .map((s) => ({ slug: s.slug, name: s.name, source: s.source }))
              .sort((a, b) => a.slug.localeCompare(b.slug)),
            nodes,
          });
        }

        // POST /panel/api/personas — onboard a runtime (non-git) persona.
        if (seg.length === 3 && req.method === "POST") {
          const denied = requireSuperadmin(role, { action: "persona.create", operator: operatorId });
          if (denied) return denied;
          const b = await readBody();
          if (!b) return json(400, { error: "invalid JSON body" });
          const name = b.name;
          if (typeof name !== "string" || !PERSONA_NAME_RE.test(name)) {
            return json(422, { error: "persona name must match ^[a-z0-9][a-z0-9-]{0,62}$" });
          }
          if (typeof b.soul !== "string" || !b.soul.trim()) return json(422, { error: "soul text is required" });
          if (name !== "default" && (typeof b.slackUserId !== "string" || !b.slackUserId)) {
            return json(422, { error: "slackUserId is required" });
          }
          if (b.model != null && (typeof b.model !== "string" || !b.model)) return json(422, { error: "model must be a non-empty string" });
          if (b.userToken != null && typeof b.userToken !== "string") return json(422, { error: "userToken must be a string" });
          if (b.mcp != null) {
            try { assertHttpOnlyMcp(b.mcp); } catch (e) {
              if (e instanceof McpNotHttpOnlyError) return json(422, { error: e.message });
              throw e;
            }
          }
          try {
            const row: DesiredPersona = {
              name,
              slackUserId: typeof b.slackUserId === "string" ? b.slackUserId : null,
              userToken: typeof b.userToken === "string" && b.userToken ? b.userToken : null,
              model: typeof b.model === "string" ? b.model : null,
              soulMd: b.soul,
              soulJson: await extractSoul(b.soul),
              mcp: b.mcp ?? null,
              origin: "runtime",
              tombstonedAt: null,
            };
            await Personas.createRuntimePersona(tenant, row, operatorId);
          } catch (e) {
            const r = status(e);
            if (r) return r;
            throw e;
          }
          const reload = await publishConfigReload(deps.pubsub, tenant);
          // The detail names the persona only; the body (and its userToken) is never logged.
          audit({ action: "persona.create", operator: operatorId, role, outcome: "ok", detail: { tenantId: tenant, persona: name } });
          return json(200, { ok: true, name, ...reload });
        }

        // PUT|DELETE /panel/api/personas/:name/overrides/:field
        if (seg.length === 6 && seg[4] === "overrides") {
          if (req.method !== "PUT" && req.method !== "DELETE") return json(405, { error: "method not allowed" });
          const denied = requireSuperadmin(role, { action: "persona.override", operator: operatorId });
          if (denied) return denied;
          let name: string;
          try { name = decodeURIComponent(seg[3]!); } catch { return json(422, { error: "invalid persona name" }); }
          if (!PERSONA_NAME_RE.test(name)) return json(422, { error: "invalid persona name" });
          const field = seg[5] as OverrideField;
          if (!OVERRIDE_FIELDS.includes(field)) {
            return json(422, { error: `only ${OVERRIDE_FIELDS.join(", ")} can be overridden` });
          }
          // PUT and DELETE agree on an unmanaged tenant: 409 before any existence check.
          if (!(await Personas.isManaged(tenant))) return json(409, { error: new Personas.NotManagedError(tenant).message });
          let removed: boolean | undefined;
          try {
            if (req.method === "PUT") {
              const b = await readBody();
              if (!b || !("value" in b)) return json(400, { error: "body must be { value }" });
              const v = b.value;
              let stored: unknown = v;
              if (field === "soul") {
                if (typeof v !== "string" || !v.trim()) return json(422, { error: "soul value must be non-empty text" });
                stored = { soulMd: v, soulJson: await extractSoul(v) };
              } else if (field === "model") {
                if (typeof v !== "string" || !v) return json(422, { error: "model value must be a non-empty string" });
              } else {
                try { assertHttpOnlyMcp(v); } catch (e) {
                  if (e instanceof McpNotHttpOnlyError) return json(422, { error: e.message });
                  throw e;
                }
              }
              await Personas.setOverride(tenant, name, field, stored, operatorId);
            } else {
              const live = await Personas.effectivePersonas(tenant);
              if (!live.some((p) => p.name === name)) return json(404, { error: `no live persona named '${name}'` });
              removed = await Personas.clearOverride(tenant, name, field);
            }
          } catch (e) {
            const r = status(e);
            if (r) return r;
            throw e;
          }
          const reload = await publishConfigReload(deps.pubsub, tenant);
          // A DELETE that removed nothing changed nothing: no audit row.
          if (req.method === "PUT" || removed) {
            audit({
              action: "persona.override", operator: operatorId, role, outcome: "ok",
              detail: { tenantId: tenant, persona: name, field, op: req.method === "PUT" ? "set" : "clear" },
            });
          }
          return json(200, { ok: true, ...(removed !== undefined ? { removed } : {}), ...reload });
        }
        return json(404, { error: "not found" });
      }

      // GET /panel/api/sessions
      if (seg.length === 3 && seg[2] === "sessions") {
        if (req.method !== "GET") return json(405, { error: "method not allowed" });
        const q = url.searchParams;
        const limit = q.get("limit") ? Number(q.get("limit")) : undefined;
        const offset = q.get("offset") ? Number(q.get("offset")) : undefined;
        const sessions = await enumerateSessions(
          {
            persona: q.get("persona") ?? undefined,
            status: q.get("status") ?? undefined,
            tenant: q.get("tenant") ?? undefined,
            limit: Number.isFinite(limit) ? limit : undefined,
            offset: Number.isFinite(offset) ? offset : undefined,
          },
          {
            registry: deps.registry,
            local: deps.local ?? null,
            turnsInFlight: (ids) => streamTurnsInFlight(deps.pubsub, ids),
            panelOwners: deps.panelLock ? (ids) => deps.panelLock!.ownerMany(ids) : undefined,
          },
        );
        return json(200, { sessions } satisfies SessionsResponse);
      }

      // /panel/api/sessions/:id[/sub]
      if (seg.length >= 4 && seg[2] === "sessions") {
        const id = seg[3]!;
        const sub = seg[4];

        // GET /panel/api/sessions/:id/audit, before the row lookup: the audit
        // trail outlives a session row.
        if (sub === "audit" && seg.length === 5) {
          if (req.method !== "GET") return json(405, { error: "method not allowed" });
          const q = pageQuerySchema.safeParse(queryOf(url));
          if (!q.success) return json(400, { error: issuesLine(q.error) });
          const page = await AuditEvents.list({ sessionId: id }, q.data);
          return json(200, page satisfies AuditPageResponse);
        }

        const row = await Sessions.findById(id);
        if (!row) return json(404, { error: "session not found" });

        // GET /panel/api/sessions/:id
        if (!sub) {
          if (req.method !== "GET") return json(405, { error: "method not allowed" });
          const [lockedBy, live] = await Promise.all([deps.panelLock ? deps.panelLock.owner(id) : null, liveness(row)]);
          // Earlier turns: GET .../history (the durable conversation record);
          // the live tail is the SSE endpoint.
          return json(200, {
            session: row,
            panel_locked_by: lockedBy ?? undefined,
            warm: live.warm,
            ...(live.inFlight !== undefined ? { turn_in_flight: live.inFlight } : {}),
            activity: activityOf(row.status, live.warm, live.inFlight),
          } satisfies SessionDetailResponse);
        }

        // GET /panel/api/sessions/:id/history: earlier turns from the session's
        // conversation record. Same access as the session detail.
        if (sub === "history" && seg.length === 5) {
          if (req.method !== "GET") return json(405, { error: "method not allowed" });
          const q = historyQuerySchema.safeParse(queryOf(url));
          if (!q.success) return json(400, { error: issuesLine(q.error) });
          const unavailable = deps.memory ? null : memoryUnavailableReason();
          if (unavailable) return json(200, { items: [], nextCursor: null, note: unavailable } satisfies SessionHistoryResponse);
          try {
            const page = await sessionHistory(row, deps.memory ?? localMemoryBrowser(), {
              before: q.data.cursor ? Number(q.data.cursor) : undefined,
              limit: q.data.limit ?? HISTORY_PAGE,
            });
            return json(200, page satisfies SessionHistoryResponse);
          } catch (e) {
            console.error(`[panel] session history read failed session=${id}: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
            return json(200, { items: [], nextCursor: null, note: "the conversation record could not be read" } satisfies SessionHistoryResponse);
          }
        }

        // GET /panel/api/sessions/:id/events  (SSE)
        if (sub === "events") {
          if (req.method !== "GET") return json(405, { error: "method not allowed" });
          return await handleEvents(req, id, auth.expMs);
        }

        // POST /panel/api/sessions/:id/chat
        if (sub === "chat") {
          if (req.method !== "POST") return json(405, { error: "method not allowed" });
          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return json(400, { error: "malformed JSON body" });
          }
          const parsed = chatSchema.safeParse(body);
          if (!parsed.success) return json(400, { error: "text is required" });
          // Exclusive control before driving the session (design §Data flow).
          if (deps.panelLock) {
            const owner = await deps.panelLock.owner(id);
            if (owner && owner !== operatorId) {
              return json(409, { error: "session is driven by another operator", owner });
            }
            let acquiredHere = false;
            const got = await deps.panelLock.acquire(id, operatorId);
            if (!got) return json(409, { error: "could not acquire active-surface lock" });
            acquiredHere = true;
            deps.onLockHeld?.(id, operatorId, deps.panelLock.ttlMs);
            audit({ action: "chat", operator: operatorId, role, session: id });
            try {
              await deps.chat(row, parsed.data.text, operatorId);
            } catch (e) {
              // F5: a chat that fails AFTER we acquired the lock must not leave
              // Slack paused for the full TTL — release what this call took.
              if (acquiredHere) {
                await deps.panelLock.release(id, operatorId).catch(() => {});
                await deps.onLockReleased?.(id);
              }
              console.error(`[panel] chat enqueue failed session=${id}:`, e);
              return json(502, { error: "chat enqueue failed" });
            }
            return json(202, { ok: true, locked_by: operatorId });
          }
          // No lock backend (mono without Redis): dispatch without exclusivity.
          audit({ action: "chat", operator: operatorId, role, session: id });
          await deps.chat(row, parsed.data.text, operatorId);
          return json(202, { ok: true });
        }

        // POST /panel/api/sessions/:id/control
        if (sub === "control") {
          if (req.method !== "POST") return json(405, { error: "method not allowed" });
          return await handleControl(req, row, operatorId, role);
        }

        // POST /panel/api/sessions/:id/lock  (take control without chatting)
        if (sub === "lock") {
          if (req.method !== "POST") return json(405, { error: "method not allowed" });
          if (!deps.panelLock) return json(503, { error: "lock unavailable (no Redis)" });
          const owner = await deps.panelLock.owner(id);
          if (owner && owner !== operatorId) return json(409, { error: "held by another operator", owner });
          const got = await deps.panelLock.acquire(id, operatorId);
          if (!got) return json(409, { error: "could not acquire lock" });
          deps.onLockHeld?.(id, operatorId, deps.panelLock.ttlMs);
          audit({ action: "lock", operator: operatorId, role, session: id });
          return json(200, { ok: true, locked_by: operatorId, ttl_ms: deps.panelLock.ttlMs });
        }

        // POST /panel/api/sessions/:id/heartbeat
        if (sub === "heartbeat") {
          if (req.method !== "POST") return json(405, { error: "method not allowed" });
          if (!deps.panelLock) return json(503, { error: "lock unavailable (no Redis)" });
          const ok = await deps.panelLock.heartbeat(id, operatorId);
          if (ok) deps.onLockHeld?.(id, operatorId, deps.panelLock.ttlMs);
          return json(ok ? 200 : 409, { ok, ttl_ms: deps.panelLock.ttlMs });
        }

        // POST /panel/api/sessions/:id/release
        if (sub === "release") {
          if (req.method !== "POST") return json(405, { error: "method not allowed" });
          if (!deps.panelLock) return json(503, { error: "lock unavailable (no Redis)" });
          const released = await deps.panelLock.release(id, operatorId);
          if (released) {
            audit({ action: "release", operator: operatorId, role, session: id });
            await deps.onLockReleased?.(id);
          }
          return json(200, { ok: true, released });
        }

        // POST /panel/api/sessions/:id/force-release  (STEAL a contended lock)
        if (sub === "force-release") {
          if (req.method !== "POST") return json(405, { error: "method not allowed" });
          if (!deps.panelLock) return json(503, { error: "lock unavailable (no Redis)" });
          const denied = requireSuperadmin(role, { action: "force-release", operator: operatorId, session: id });
          if (denied) return denied;
          // F4: force-release transfers control to the CALLER — it does not
          // hand the session back to Slack. The lock stays held under the new
          // owner (Slack still suppressed), the displaced operator's heartbeat
          // starts failing (they lost control), and the caller drives.
          const displaced = await deps.panelLock.steal(id, operatorId);
          deps.onLockHeld?.(id, operatorId, deps.panelLock.ttlMs);
          audit({
            action: "force-release",
            operator: operatorId,
            role,
            session: id,
            detail: { displaced: displaced ?? null, newOwner: operatorId },
          });
          return json(200, { ok: true, owner: operatorId, displaced: displaced ?? undefined });
        }
      }

      return json(404, { error: "not found" });
    } catch (e) {
      console.error(`[panel] ${req.method} ${url.pathname} failed:`, e);
      return json(500, { error: "internal" });
    }
  }

  return { fetch };
}
