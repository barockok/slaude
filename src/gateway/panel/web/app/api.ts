// Panel API client. Two backends behind one interface:
//   - real: fetch + EventSource against /panel/api, authenticated by the panel's
//     own HttpOnly session cookie. Identity is never in a header or the URL —
//     it is read back from /panel/auth/me.
//   - mock: in-browser fixtures + a scripted emitter, for ?mock=1 (gauntlet
//     screenshots with no backend at all).
import type { SessionSummary, AgentEvent, TimelineEntry, Me } from "./types";
import { FIXTURE_SESSIONS, SCRIPT, OPERATOR, DETAIL_ID } from "./fixtures";

export class ApiError extends Error {
  constructor(public status: number, public body: any) {
    super(body?.error ?? `HTTP ${status}`);
  }
}

export interface ListFilters { persona?: string; status?: string; }
export interface Backend {
  /** Signed-in identity. Empty until `me()` resolves. */
  operator: string;
  /** Panel role, re-resolved server-side per request; null until `me()` resolves. */
  role: "superadmin" | "operator" | null;
  mock: boolean;
  /** Current session identity, or null when there is no valid session. */
  me(): Promise<Me | null>;
  logout(): Promise<void>;
  listSessions(f: ListFilters): Promise<SessionSummary[]>;
  getSession(id: string): Promise<{ session: any; panel_locked_by?: string }>;
  control(id: string, body: Record<string, unknown>): Promise<{ ok: boolean; session: any }>;
  chat(id: string, text: string): Promise<{ ok: boolean; locked_by: string }>;
  lock(id: string): Promise<{ ok: boolean; locked_by: string; ttl_ms: number }>;
  heartbeat(id: string): Promise<{ ok: boolean; ttl_ms: number }>;
  release(id: string): Promise<{ ok: boolean; released: boolean }>;
  forceRelease(id: string): Promise<{ ok: boolean; displaced?: string }>;
  subscribe(id: string, onEntry: (e: TimelineEntry) => void): () => void;
}

const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
export const IS_MOCK = params.get("mock") === "1";
// no-redis flag lets the gauntlet/e2e exercise the 503 degradation path.
export const FORCE_503 = params.get("noredis") === "1";

// The operator identity now comes from the panel session cookie, not a header
// or a query parameter. `?op=` survives only in the mock backend, where it
// labels the fixture operator.
function mockOperatorId(): string {
  return params.get("op") || OPERATOR;
}

// A 403 that is not action-scoped ("you are not on any role list") is an
// identity problem, not a failed click: App renders a dedicated screen for it.
// Action-scoped denials carry `required` and stay with their caller.
type ForbiddenListener = (body: { error?: string } | null) => void;
let forbiddenListener: ForbiddenListener | null = null;
export function onForbidden(cb: ForbiddenListener | null): void {
  forbiddenListener = cb;
}

// ---------------- real backend ----------------
function realBackend(): Backend {
  const base = "/panel/api";
  const authBase = "/panel/auth";
  // `x-panel-csrf` is the anti-CSRF marker the server requires on mutating
  // requests; a cross-site page cannot set a custom header without a preflight.
  const headers = { "content-type": "application/json", "x-panel-csrf": "1" };

  function toLogin(): never {
    location.href = `${authBase}/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`;
    throw new ApiError(401, { error: "session expired" });
  }

  async function once(path: string, init?: RequestInit) {
    return fetch(base + path, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
  }

  async function req(path: string, init?: RequestInit) {
    let r = await once(path, init);
    if (r.status === 401) {
      // Exactly one refresh attempt, then one retry. A second 401 means the
      // refresh window closed too — send the operator back to the provider.
      const refreshed = await fetch(`${authBase}/refresh`, { method: "POST", headers });
      if (!refreshed.ok) toLogin();
      r = await once(path, init);
      if (r.status === 401) toLogin();
    }
    const body = r.status === 204 ? null : await r.json().catch(() => null);
    if (!r.ok) {
      if (r.status === 403 && !(body as any)?.required) forbiddenListener?.(body);
      throw new ApiError(r.status, body);
    }
    return body;
  }

  const backend: Backend = {
    operator: "",
    role: null,
    mock: false,
    async me() {
      // Deliberately outside the refresh/retry path: a 401 here just means "not
      // signed in", and the caller sends the operator to the provider.
      const r = await fetch(`${authBase}/me`, { headers: { "content-type": "application/json" } });
      if (r.status === 401) return null;
      const body = await r.json().catch(() => null);
      if (!r.ok) {
        if (r.status === 403) forbiddenListener?.(body);
        throw new ApiError(r.status, body);
      }
      const m = body as Me;
      backend.operator = m.email;
      backend.role = m.role;
      return m;
    },
    async logout() {
      await fetch(`${authBase}/logout`, { method: "POST", headers });
      location.href = `${authBase}/login`;
    },
    async listSessions(f) {
      const q = new URLSearchParams();
      if (f.persona) q.set("persona", f.persona);
      if (f.status) q.set("status", f.status);
      const b = await req(`/sessions${q.toString() ? `?${q}` : ""}`);
      return b.sessions as SessionSummary[];
    },
    getSession: (id) => req(`/sessions/${id}`),
    control: (id, body) => req(`/sessions/${id}/control`, { method: "POST", body: JSON.stringify(body) }),
    chat: (id, text) => req(`/sessions/${id}/chat`, { method: "POST", body: JSON.stringify({ text }) }),
    lock: (id) => req(`/sessions/${id}/lock`, { method: "POST" }),
    heartbeat: (id) => req(`/sessions/${id}/heartbeat`, { method: "POST" }),
    release: (id) => req(`/sessions/${id}/release`, { method: "POST" }),
    forceRelease: (id) => req(`/sessions/${id}/force-release`, { method: "POST" }),
    subscribe(id, onEntry) {
      // No identity in the URL (PII leaks into access logs / history / Referer):
      // SSE is a GET, so the same-origin session cookie authenticates it, and
      // EventSource resends Last-Event-ID via header on reconnect.
      const url = `${base}/sessions/${id}/events`;
      const es = new EventSource(url);
      es.onmessage = (m) => {
        try {
          const event = JSON.parse(m.data) as AgentEvent;
          onEntry({ id: m.lastEventId || String(Date.now()), ts: Date.now(), event });
        } catch { /* ignore malformed frame */ }
      };
      es.onerror = () => { /* EventSource auto-reconnects; keep the tail open */ };
      return () => es.close();
    },
  };
  return backend;
}

// ---------------- mock backend ----------------
function mockBackend(): Backend {
  const op = mockOperatorId();
  let sessions = FIXTURE_SESSIONS.map((s) => ({ ...s }));
  const locks = new Map<string, string>();
  for (const s of sessions) if (s.panel_locked_by) locks.set(s.id, s.panel_locked_by);
  const injected: Record<string, AgentEvent[]> = {};

  const clone503 = () => { throw new ApiError(503, { error: "unavailable (no Redis)" }); };

  return {
    operator: op,
    // The fixture operator is a superadmin so ?mock=1 screenshots keep every
    // control live; the real server remains the authority everywhere else.
    role: "superadmin",
    mock: true,
    async me() { return { email: op, role: "superadmin" as const }; },
    async logout() { /* no provider behind the fixtures */ },
    async listSessions(f) {
      // jitter one running session's ctx to make auto-refresh visibly live
      const r = sessions.find((s) => s.status === "running");
      if (r && r.ctx_pct != null) r.ctx_pct = Math.min(0.97, r.ctx_pct + (Math.random() - 0.4) * 0.02);
      return sessions
        .filter((s) => (!f.persona || s.persona_id === f.persona) && (!f.status || s.status === f.status))
        .map((s) => ({ ...s, panel_locked_by: locks.get(s.id) }));
    },
    async getSession(id) {
      const s = sessions.find((x) => x.id === id);
      if (!s) throw new ApiError(404, { error: "not found" });
      return { session: s, panel_locked_by: locks.get(id) };
    },
    async control(id, body) {
      if (FORCE_503 && body.action === "stop") clone503();
      const s = sessions.find((x) => x.id === id)!;
      if (body.action === "model" && body.model) s.model = String(body.model);
      if (body.action === "reset") s.claude_started = 0;
      injected[id] = injected[id] ?? [];
      injected[id]!.push({ type: "assistantText", sessionId: id, text: `[operator ${op} issued ${body.action}]` });
      return { ok: true, session: { ...s } };
    },
    async chat(id, text) {
      if (FORCE_503) clone503();
      const owner = locks.get(id);
      if (owner && owner !== op) throw new ApiError(409, { error: "driven by another operator", owner });
      locks.set(id, op);
      injected[id] = injected[id] ?? [];
      injected[id]!.push({ type: "assistantText", sessionId: id, text: `On it. ${text.length > 40 ? "" : "(" + text + ")"}` });
      return { ok: true, locked_by: op };
    },
    async lock(id) {
      if (FORCE_503) clone503();
      const owner = locks.get(id);
      if (owner && owner !== op) throw new ApiError(409, { error: "held by another operator", owner });
      locks.set(id, op);
      return { ok: true, locked_by: op, ttl_ms: 45000 };
    },
    async heartbeat() { return { ok: true, ttl_ms: 45000 }; },
    async release(id) { locks.delete(id); return { ok: true, released: true }; },
    async forceRelease(id) { const d = locks.get(id); locks.set(id, op); return { ok: true, displaced: d }; },
    subscribe(id, onEntry) {
      let i = 0, alive = true, seq = 0;
      const frames = id === DETAIL_ID ? SCRIPT : SCRIPT.slice(0, 4);
      // Virtual event clock: advance by each frame's scripted delay so the
      // timeline reads the designed spacing (a 1.4s query, a 2.8s test) rather
      // than the compressed wall-clock replay cadence. Anchored near load time
      // so exact-on-hover timestamps still look plausible.
      let vts = Date.now() - 6000;
      const push = (event: AgentEvent, advance: number) => { vts += advance; onEntry({ id: `mock-${++seq}`, ts: vts, event }); };
      const gap = (d: number) => Math.max(30, Math.round(d * 0.35)); // scaled scripted timing
      const tick = () => {
        if (!alive) return;
        if (i < frames.length) { const f = frames[i]!; i++; push(f.event, f.delay); setTimeout(tick, gap(frames[i]?.delay ?? 200)); return; }
        // drain any operator-injected events, then idle
        const inj = injected[id];
        if (inj && inj.length) push(inj.shift()!, 500);
        setTimeout(tick, 400);
      };
      setTimeout(tick, 30);
      return () => { alive = false; };
    },
  };
}

let _backend: Backend | null = null;
export function api(): Backend {
  if (!_backend) _backend = IS_MOCK ? mockBackend() : realBackend();
  return _backend;
}
