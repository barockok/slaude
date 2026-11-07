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
 */
import type {
  AgentSummary, ConsoleGrantView, CreateGrantRequest, GrantView,
} from "../../../gateway/panel/api-types";
import { createFixtures, type ConsoleFixtures } from "./fixtures";

const ID_RE = { user: /^[UW][A-Z0-9]+$/, channel: /^[CGD][A-Z0-9]+$/, workspace: /^T[A-Z0-9]+$/ } as const;
const ID_SHAPE = {
  user: "a Slack user id (U or W followed by uppercase letters and digits)",
  channel: "a Slack channel id (C, G or D followed by uppercase letters and digits)",
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

  const fx = createFixtures();
  if (sticky("as") === "operator") fx.me = { email: "bob@example.com", role: "operator" };
  if (empty) {
    fx.agents = {};
    fx.audit = [];
    fx.counts = { liveSessions: 0, pendingApprovals: 0 };
  }
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
    if (path === "/api/console-roles") return json(200, fx.roles);
    if (path === "/api/audit") {
      let items = fx.audit;
      const persona = query.get("persona"), action = query.get("action"), actor = query.get("actor"), session = query.get("session");
      if (persona) items = items.filter((e) => e.persona === persona);
      if (action) items = items.filter((e) => e.action === action);
      if (actor) items = items.filter((e) => e.actorId === actor);
      if (session) items = items.filter((e) => e.sessionId === session);
      const cursor = query.get("cursor");
      if (cursor) items = items.filter((e) => e.id < cursor);
      const limit = Math.min(500, Number(query.get("limit") ?? 50));
      const page = items.slice(0, limit);
      return json(200, { items: page, nextCursor: items.length > limit ? page[page.length - 1]!.id : null });
    }
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
