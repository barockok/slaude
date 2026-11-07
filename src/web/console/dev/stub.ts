/**
 * Dev-only stub of the console API: a fetch interceptor over the fixtures, so
 * the console runs and can be screenshotted without a gateway. Enabled by
 * `VITE_STUB=1 bun run panel:dev`; production builds never include it.
 *
 * URL switches (read once at load, kept for the tab's lifetime):
 *   ?as=operator         sign in as an operator instead of a superadmin
 *   ?stubDelay=800       response delay in ms (default 250; 0 for none)
 *   ?stubFail=overview   answer 500 for API paths containing the text
 *   ?stubEmpty=1         no agents, grants or audit events
 *   ?stubHang=agents     never answer API paths containing the text (skeletons)
 *   ?stubMono=1          a single-process deployment: no node pools, no lock backend
 *   ?stubNoHistory=1     memory is off: the history route answers a note, no turns
 */
import type {
  AgentSummary, ConsoleGrantView, CreateGrantRequest, GrantView, SessionActivity, SessionControlRequest, SessionEvent, SessionSummaryView,
} from "../../../gateway/panel/api-types";
import { CHANNEL_LABELS, USER_NAMES, allGrantsOf, createFixtures, sessionHistory, sessionScript, type ConsoleFixtures } from "./fixtures";

const ID_RE = { user: /^[UW][A-Z0-9]+$/, channel: /^[CG][A-Z0-9]+$/, workspace: /^T[A-Z0-9]+$/ } as const;
const ID_SHAPE = {
  user: "a Slack user id (U or W followed by uppercase letters and digits)",
  channel: "a Slack channel id (C or G followed by uppercase letters and digits)",
  workspace: "a Slack workspace id (T followed by uppercase letters and digits)",
} as const;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function summary(d: ConsoleFixtures["agents"][string]): AgentSummary {
  const { mandates: _m, grants, ...rest } = d;
  return { ...rest, mandateCount: d.mandates.length, grantCount: grants.filter((g) => g.source === "console").length };
}

/** Same rules and messages as the server (src/db/agent-grants.ts, panel/api.ts). */
function validateGrant(b: CreateGrantRequest): string | null {
  if (!["user", "channel", "workspace"].includes(b.subjectKind)) return "subjectKind: Invalid enum value";
  if (!["manager", "approver", "member"].includes(b.role)) return "role: Invalid enum value";
  if (b.expiresAt != null && b.expiresAt <= Date.now()) return "expiresAt must be in the future";
  if (b.subjectKind !== "user") {
    if (b.role !== "member") return `a ${b.subjectKind} subject can only be granted member, not ${b.role}`;
    if (b.deny) return `deny applies to user subjects only, not ${b.subjectKind}`;
    if (b.dmOnly) return `dm_only applies to user subjects only, not ${b.subjectKind}`;
  }
  const id = (b.subjectId ?? "").trim();
  if (b.subjectKind === "channel" && /^D[A-Z0-9]+$/.test(id)) {
    return `agent grant: a channel subject_id must be a channel, not a DM (${JSON.stringify(id)}); DMs are covered by a user member grant with dm_only`;
  }
  if (!ID_RE[b.subjectKind].test(id)) return `a ${b.subjectKind} subject_id must be ${ID_SHAPE[b.subjectKind]}, got ${JSON.stringify(id)}`;
  return null;
}

export function installStub(): void {
  const params = new URLSearchParams(location.search);
  const sticky = (k: string) => {
    const v = params.get(k);
    try {
      if (v !== null) sessionStorage.setItem(`slaude.stub.${k}`, v);
      return v ?? sessionStorage.getItem(`slaude.stub.${k}`);
    } catch {
      return v;
    }
  };
  const delay = Number(sticky("stubDelay") ?? 250);
  const fail = sticky("stubFail");
  const hang = sticky("stubHang");
  const empty = sticky("stubEmpty") === "1";
  const mono = sticky("stubMono") === "1";
  const noHistory = sticky("stubNoHistory") === "1";
  /** Sessions with a scripted turn in flight right now (turnStart sent, done not yet). */
  const working = new Set<string>();

  const fx = createFixtures();
  const startedAt = Date.now();
  if (sticky("as") === "operator") fx.me = { email: "bob@example.com", role: "operator" };
  if (empty) {
    fx.agents = {};
    fx.audit = [];
    fx.counts = { liveSessions: 0, pendingApprovals: 0 };
    fx.sessions = [];
    fx.locks = {};
    fx.memory = { stores: [], pages: {} };
    fx.environments = { nodePools: [], personas: [], personal: [] };
  }
  if (mono) {
    fx.environments = {
      ...fx.environments,
      nodePools: [],
      personas: fx.environments.personas.map((p) => ({ ...p, runsOn: "local" })),
    };
  }
  /** Events waiting to go out on each session's live tail (operator chat replies). */
  const pendingEvents = new Map<string, Array<{ delay: number; event: SessionEvent }>>();
  let nextGrant = 100;

  const realFetch = window.fetch.bind(window);

  async function handle(method: string, path: string, query: URLSearchParams, body: unknown): Promise<Response> {
    if (path === "/auth/me") return json(200, fx.me);
    if (path === "/auth/refresh") return json(200, { ok: true });
    if (path === "/auth/logout") return json(200, { ok: true });
    if (!path.startsWith("/api/")) return json(404, { error: "not found" });

    const seg = path.split("/").filter(Boolean); // ["api", ...]
    const isSuper = fx.me.role === "superadmin";

    if (path === "/api/overview") {
      const dayAgo = Date.now() - 24 * 3_600_000;
      return json(200, {
        counts: {
          agents: Object.keys(fx.agents).length,
          liveSessions: fx.counts.liveSessions,
          pendingApprovals: fx.counts.pendingApprovals,
          auditEvents24h: fx.audit.filter((e) => e.at >= dayAgo).length,
        },
        recentAudit: fx.audit.slice(0, 10),
      });
    }
    if (path === "/api/console-roles") {
      if (!isSuper) return json(403, { error: "action 'console.roles.read' requires the superadmin role", required: "superadmin" });
      return json(200, fx.roles);
    }
    if (path === "/api/grants") return method === "GET" ? json(200, allGrantsOf(fx)) : json(405, { error: "method not allowed" });
    if (path === "/api/audit") {
      let items = fx.audit;
      const persona = query.get("persona"), action = query.get("action"), actor = query.get("actor"), session = query.get("session");
      if (persona) items = items.filter((e) => e.persona === persona);
      if (action) items = items.filter((e) => (action.endsWith(".") ? e.action.startsWith(action) : e.action === action));
      if (actor) items = items.filter((e) => e.actorId === actor);
      if (session) items = items.filter((e) => e.sessionId === session);
      const decision = query.get("decision"), since = query.get("since"), until = query.get("until");
      if (decision) items = items.filter((e) => e.decision === decision);
      if (since) items = items.filter((e) => e.at >= Number(since));
      if (until) items = items.filter((e) => e.at <= Number(until));
      const cursor = query.get("cursor");
      if (cursor) items = items.filter((e) => e.id < cursor);
      const limit = Math.min(500, Number(query.get("limit") ?? 50));
      const page = items.slice(0, limit);
      return json(200, { items: page, nextCursor: items.length > limit ? page[page.length - 1]!.id : null });
    }
    if (seg[1] === "sessions") return sessions(method, seg, query, body, isSuper);
    if (seg[1] === "memory") return memory(seg, query, isSuper);
    if (path === "/api/environments") return json(200, fx.environments);
    if (seg[1] === "agents") {
      if (seg.length === 2) return json(200, { agents: Object.values(fx.agents).map(summary) });
      const agent = fx.agents[decodeURIComponent(seg[2]!)];
      if (!agent) return json(404, { error: `no agent named '${decodeURIComponent(seg[2]!)}'` });
      if (seg.length === 3) return json(200, { ...agent, ...summary(agent) });
      if (seg[3] !== "grants") return json(404, { error: "not found" });
      if (seg.length === 4 && method === "GET") return json(200, { grants: agent.grants });
      if (!isSuper) {
        const action = method === "POST" ? "grant.create" : "grant.revoke";
        return json(403, { error: `action '${action}' requires the superadmin role`, required: "superadmin" });
      }
      if (seg.length === 4 && method === "POST") {
        const b = body as CreateGrantRequest;
        const err = validateGrant(b);
        if (err) return json(400, { error: err });
        const grant: ConsoleGrantView = {
          source: "console",
          id: `g_${nextGrant++}`,
          subjectKind: b.subjectKind,
          subjectId: b.subjectId.trim(),
          role: b.role,
          deny: !!b.deny,
          dmOnly: !!b.dmOnly,
          createdBy: fx.me.email,
          createdAt: Date.now(),
          expiresAt: b.expiresAt ?? null,
          note: b.note ?? null,
        };
        agent.grants = [...agent.grants, grant];
        return json(201, { grant });
      }
      if (seg.length === 5 && method === "DELETE") {
        const id = decodeURIComponent(seg[4]!);
        const before = agent.grants.length;
        agent.grants = agent.grants.filter((g: GrantView) => g.source !== "console" || g.id !== id);
        return agent.grants.length < before ? json(200, { ok: true }) : json(404, { error: "no such grant on this agent" });
      }
      return json(405, { error: "method not allowed" });
    }
    return json(404, { error: "not found" });
  }

  function sessionSummary(r: ConsoleFixtures["sessions"][number]): SessionSummaryView {
    const { permission_mode: _p, slack_app_id: _a, ...rest } = r;
    return { ...rest, activity: activityOf(r), panel_locked_by: fx.locks[r.id], ...modelOf(r), ...labelOf(r), surface: "slack" };
  }

  /** The row's model, else the agent's configured one, else the deployment default (as the server). */
  function modelOf(r: { model: string; persona_id: string }): Pick<SessionSummaryView, "effective_model" | "model_source"> {
    if (r.model) return { effective_model: r.model, model_source: "session" };
    const agent = fx.agents[r.persona_id]?.model;
    return agent ? { effective_model: agent, model_source: "agent" } : { effective_model: null, model_source: "deployment" };
  }

  /** What the gateway's cached Slack lookup answers; an unknown channel keeps its id. */
  function labelOf(r: { slack_channel_id: string | null }): { channel_label?: string } {
    const l = r.slack_channel_id ? CHANNEL_LABELS[r.slack_channel_id] : undefined;
    return l ? { channel_label: l } : {};
  }

  /** Warm rows are working while their scripted turn runs; a stored `running` row nothing holds is idle. */
  function activityOf(r: ConsoleFixtures["sessions"][number]): SessionActivity {
    if (r.warm) return working.has(r.id) ? "working" : "warm";
    return r.status === "error" ? "error" : "idle";
  }

  function sessions(method: string, seg: string[], query: URLSearchParams, body: unknown, isSuper: boolean): Response {
    const me = fx.me.email;
    if (seg.length === 2) {
      const persona = query.get("persona"), status = query.get("status");
      const rows = fx.sessions
        .filter((r) => (!persona || r.persona_id === persona) && (!status || r.status === status))
        .map(sessionSummary);
      const limit = Math.min(499, Number(query.get("limit") ?? 50));
      const offset = Number(query.get("offset") ?? 0);
      const page = rows.slice(offset, offset + limit);
      return json(200, { sessions: page, nextOffset: offset + limit < rows.length ? offset + limit : null });
    }
    const id = decodeURIComponent(seg[2]!);
    const sub = seg[3];
    if (sub === "audit") {
      const items = fx.audit.filter((e) => e.sessionId === id);
      return json(200, { items, nextCursor: null });
    }
    const row = fx.sessions.find((r) => r.id === id);
    if (!row) return json(404, { error: "session not found" });
    if (!sub) {
      const { warm, node: _n, ...session } = row;
      return json(200, {
        session, panel_locked_by: fx.locks[id], warm, activity: activityOf(row),
        ...(warm ? { turn_in_flight: working.has(id) } : {}),
        ...modelOf(row), ...labelOf(row), surface: "slack",
      });
    }
    if (sub === "history") {
      if (noHistory) return json(200, { items: [], nextCursor: null, note: "memory is disabled on this deployment (SLAUDE_BRAIN_DISABLED=1)" });
      const lines = sessionHistory(id, startedAt);
      // One turn is a user line and the agent line after it; the cursor counts turns.
      const turns: typeof lines[] = [];
      for (let i = 0; i < lines.length; i += 2) turns.push(lines.slice(i, i + 2));
      const before = query.get("cursor") ? Number(query.get("cursor")) : turns.length;
      const limit = Number(query.get("limit") ?? 20);
      const start = Math.max(0, before - limit);
      const items = turns.slice(start, before).flat();
      const users: Record<string, string> = {};
      for (const it of items) for (const m of it.text.matchAll(/<@([UW][A-Z0-9]+)>/g)) if (USER_NAMES[m[1]!]) users[m[1]!] = USER_NAMES[m[1]!]!;
      return json(200, { items, nextCursor: start > 0 ? String(start) : null, ...(Object.keys(users).length ? { users } : {}) });
    }
    if (sub === "events") return eventStream(id);
    if (method !== "POST") return json(405, { error: "method not allowed" });
    const owner = fx.locks[id];
    const lockless = mono;
    switch (sub) {
      case "lock":
        if (lockless) return json(503, { error: "lock unavailable (no Redis)" });
        if (owner && owner !== me) return json(409, { error: "held by another operator", owner });
        fx.locks[id] = me;
        return json(200, { ok: true, locked_by: me, ttl_ms: 60_000 });
      case "heartbeat":
        if (lockless) return json(503, { error: "lock unavailable (no Redis)" });
        return owner === me ? json(200, { ok: true, ttl_ms: 60_000 }) : json(409, { ok: false, ttl_ms: 60_000 });
      case "release": {
        if (lockless) return json(503, { error: "lock unavailable (no Redis)" });
        const released = owner === me;
        if (released) delete fx.locks[id];
        return json(200, { ok: true, released });
      }
      case "force-release":
        if (lockless) return json(503, { error: "lock unavailable (no Redis)" });
        if (!isSuper) return json(403, { error: "action 'force-release' requires the superadmin role", required: "superadmin" });
        fx.locks[id] = me;
        return json(200, { ok: true, owner: me, displaced: owner });
      case "chat": {
        const text = (body as { text?: string } | undefined)?.text;
        if (!text) return json(400, { error: "text is required" });
        if (!lockless) {
          if (owner && owner !== me) return json(409, { error: "session is driven by another operator", owner });
          fx.locks[id] = me;
        }
        const q = pendingEvents.get(id) ?? [];
        // The agent answers with the reply tool; while the operator holds the
        // session the reply is held in the console (Slack never sees it).
        const call = `toolu_chat_${Date.now()}`;
        const reply = `Got it. Working on: ${text.length > 80 ? `${text.slice(0, 80)}...` : text}`;
        q.push(
          { delay: 300, event: { type: "turnStart", sessionId: id } },
          { delay: 700, event: { type: "toolCall", sessionId: id, tool: "mcp__slaude_surface__reply", input: { text: reply }, toolUseId: call } },
          { delay: 150, event: { type: "toolResult", sessionId: id, tool: "mcp__slaude_surface__reply", result: [{ type: "text", text: lockless ? "posted ref=1762506060.000900" : "posted ref=panel-suppressed" }], toolUseId: call } },
          { delay: 200, event: { type: "done", sessionId: id } },
        );
        pendingEvents.set(id, q);
        return json(202, lockless ? { ok: true } : { ok: true, locked_by: me });
      }
      case "control": {
        const b = body as SessionControlRequest;
        if ((b.action === "reset" || b.action === "mode") && !isSuper) {
          return json(403, { error: `action 'control.${b.action}' requires the superadmin role`, required: "superadmin" });
        }
        if (b.action === "stop" && lockless) return json(503, { error: "stop unavailable (no Redis)" });
        if (b.action === "model") row.model = b.model;
        if (b.action === "mode") row.permission_mode = b.mode;
        if (b.action === "reset") row.claude_started = 0;
        if (b.action === "unlock-1on1" && !row.slack_thread_ts) return json(400, { error: "session has no Slack thread to unlock" });
        if (b.action === "stop") {
          row.status = "idle";
          const q = pendingEvents.get(id) ?? [];
          q.push({ delay: 200, event: { type: "error", sessionId: id, error: "turn stopped by an operator", code: "ABORTED" } });
          pendingEvents.set(id, q);
        }
        row.updated_at = Date.now();
        const { warm: _w, node: _n, ...session } = row;
        return json(200, { ok: true, session });
      }
    }
    return json(404, { error: "not found" });
  }

  /** A text/event-stream that plays the scripted turn, then operator replies, with pings. */
  function eventStream(id: string): Response {
    if (mono) return json(503, { error: "event stream unavailable (no Redis)" });
    const enc = new TextEncoder();
    let seq = 0;
    let stopped = false;
    const script = fx.sessions.find((r) => r.id === id)?.status === "running" ? sessionScript(id) : [];
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(enc.encode(": open\n\n"));
        const send = (event: SessionEvent) => {
          if (event.type === "turnStart") working.add(id);
          if (event.type === "done" || event.type === "error") working.delete(id);
          controller.enqueue(enc.encode(`id: ${Date.now()}-${seq++}\ndata: ${JSON.stringify(event)}\n\n`));
        };
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        for (const f of script) {
          if (stopped) return;
          await sleep(f.delay);
          if (!stopped) send(f.event);
        }
        while (!stopped) {
          const next = pendingEvents.get(id)?.shift();
          if (next) {
            await sleep(next.delay);
            if (!stopped) send(next.event);
            continue;
          }
          await sleep(300);
          if (!stopped) controller.enqueue(enc.encode(": ping\n\n"));
        }
      },
      cancel() {
        stopped = true;
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  function memory(seg: string[], query: URLSearchParams, isSuper: boolean): Response {
    const priv = (id: string) => /^(user-|profile-)/.test(id);
    if (seg.length === 3 && seg[2] === "stores") {
      return json(200, { stores: fx.memory.stores.filter((s) => isSuper || !priv(s.id)) });
    }
    if (seg.length === 5 && seg[2] === "stores" && seg[4] === "pages") {
      const store = decodeURIComponent(seg[3]!);
      if (priv(store) && !isSuper) return json(403, { error: "action 'memory.private' requires the superadmin role", required: "superadmin" });
      const all = [...(fx.memory.pages[store] ?? [])].sort((a, b) => (a.slug < b.slug ? -1 : 1));
      const offset = Number(query.get("cursor") ?? 0);
      const limit = Number(query.get("limit") ?? 50);
      const items = all.slice(offset, offset + limit).map(({ slug, type, title, updatedAt }) => ({ slug, type, title, updatedAt }));
      return json(200, { items, nextCursor: offset + limit < all.length ? String(offset + limit) : null });
    }
    if (seg.length === 3 && seg[2] === "pages") {
      const store = query.get("store") ?? "", slug = query.get("slug") ?? "";
      if (priv(store) && !isSuper) return json(403, { error: "action 'memory.private' requires the superadmin role", required: "superadmin" });
      const page = fx.memory.pages[store]?.find((p) => p.slug === slug);
      return page ? json(200, page) : json(404, { error: "no such page in that store" });
    }
    return json(404, { error: "not found" });
  }

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith("/panel/")) return realFetch(input, init);
    const path = url.pathname.slice("/panel".length);
    if (!path.startsWith("/api/") && !path.startsWith("/auth/")) return realFetch(input, init);

    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        return json(400, { error: "malformed JSON body" });
      }
    }
    const signal = init?.signal;
    if (hang && path.includes(hang)) return new Promise<Response>(() => undefined);
    if (delay > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delay);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    }
    if (fail && path.startsWith("/api/") && path.includes(fail)) return json(500, { error: "The stub was asked to fail this request." });
    return handle(method, path, url.searchParams, body);
  };
  console.info("[slaude] console API stub active (VITE_STUB=1)");
}
