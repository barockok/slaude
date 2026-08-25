// Panel API client. Two backends behind one interface:
//   - real: fetch + EventSource against /panel/api (operator header injected by
//     SSO/ingress in prod, by the vite dev proxy in dev, by query in the stub).
//   - mock: in-browser fixtures + a scripted emitter, for ?mock=1 (gauntlet
//     screenshots with no backend at all).
import type { SessionSummary, AgentEvent, TimelineEntry } from "./types";
import { FIXTURE_SESSIONS, SCRIPT, OPERATOR, DETAIL_ID } from "./fixtures";

export class ApiError extends Error {
  constructor(public status: number, public body: any) {
    super(body?.error ?? `HTTP ${status}`);
  }
}

export interface ListFilters { persona?: string; status?: string; }
export interface Backend {
  operator: string;
  mock: boolean;
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

function operatorId(): string {
  return params.get("op") || OPERATOR;
}

// ---------------- real backend ----------------
function realBackend(): Backend {
  const op = operatorId();
  const base = "/panel/api";
  // `x-panel-csrf` is the anti-CSRF marker the server requires on mutating
  // requests; a cross-site page cannot set a custom header without a preflight.
  const headers = { "x-auth-request-email": op, "content-type": "application/json", "x-panel-csrf": "1" };
  async function req(path: string, init?: RequestInit) {
    const r = await fetch(base + path, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
    const body = r.status === 204 ? null : await r.json().catch(() => null);
    if (!r.ok) throw new ApiError(r.status, body);
    return body;
  }
  return {
    operator: op,
    mock: false,
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
      // SSE is a GET, so the ingress-injected identity header authenticates it,
      // and EventSource resends Last-Event-ID via header on reconnect.
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
}

// ---------------- mock backend ----------------
function mockBackend(): Backend {
  const op = operatorId();
  let sessions = FIXTURE_SESSIONS.map((s) => ({ ...s }));
  const locks = new Map<string, string>();
  for (const s of sessions) if (s.panel_locked_by) locks.set(s.id, s.panel_locked_by);
  const injected: Record<string, AgentEvent[]> = {};

  const clone503 = () => { throw new ApiError(503, { error: "unavailable (no Redis)" }); };

  return {
    operator: op,
    mock: true,
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
