// Fixture-backed stand-in for the panel gateway, used by the Playwright e2e
// suite. Serves the built dist under /panel and implements the /panel/api
// contract against the shared fixtures (REST + SSE replay of the scripted
// turn). No Redis, no DB — deterministic. Env STUB_NO_REDIS=1 exercises the
// degraded 503 path; a preset lock owner drives the 409 path.
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURE_SESSIONS, SCRIPT, DETAIL_ID } from "../../src/gateway/panel/web/app/fixtures";

const PORT = Number(process.env.PORT ?? 4319);
const NO_REDIS = process.env.STUB_NO_REDIS === "1";
const DIST = join(fileURLToPath(new URL(".", import.meta.url)), "../../src/gateway/panel/web/dist");

const sessions = FIXTURE_SESSIONS.map((s) => ({ ...s }));
const locks = new Map<string, string>();
for (const s of sessions) if (s.panel_locked_by) locks.set(s.id, s.panel_locked_by);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const op = (req: Request) =>
  req.headers.get("x-auth-request-email") || new URL(req.url).searchParams.get("email") || "anon@stub";

async function serveStatic(pathname: string): Promise<Response> {
  let rel = pathname.replace(/^\/panel\/?/, "");
  if (rel === "" || rel.endsWith("/")) rel = `${rel}index.html`;
  const full = normalize(join(DIST, rel));
  if (full !== DIST && !full.startsWith(DIST + "/")) return new Response("forbidden", { status: 403 });
  const file = Bun.file(full);
  if (await file.exists()) return new Response(file);
  const idx = Bun.file(join(DIST, "index.html"));
  if (await idx.exists()) return new Response(idx, { headers: { "content-type": "text/html" } });
  return new Response("not built — run panel:build", { status: 404 });
}

function sseReplay(id: string): Response {
  const frames = id === DETAIL_ID ? SCRIPT : SCRIPT.slice(0, 4);
  const enc = new TextEncoder();
  let i = 0, seq = 0;
  let closed = false;
  const stream = new ReadableStream({
    start(c) {
      const push = (s: string) => {
        if (closed) return false;
        try { c.enqueue(enc.encode(s)); return true; } catch { closed = true; return false; }
      };
      push(": open\n\n");
      const tick = () => {
        if (closed) return;
        if (i >= frames.length) { push(": ping\n\n"); setTimeout(tick, 400); return; }
        const f = frames[i++]!;
        push(`id: stub-${++seq}\ndata: ${JSON.stringify(f.event)}\n\n`);
        setTimeout(tick, Math.max(30, Math.round((frames[i]?.delay ?? 200) * 0.35)));
      };
      setTimeout(tick, 30);
    },
    cancel() { closed = true; },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

process.on("unhandledRejection", (e) => console.error("[stub] unhandledRejection", e));

Bun.serve({
  port: PORT,
  error(e) { console.error("[stub] error", e); return new Response("stub error", { status: 500 }); },
  async fetch(req) {
    const url = new URL(req.url);
    const seg = url.pathname.split("/").filter(Boolean);
    if (seg[0] !== "panel") return new Response("not found", { status: 404 });
    if (seg[1] !== "api") return serveStatic(url.pathname);

    // /panel/api/sessions
    if (seg.length === 3 && seg[2] === "sessions") {
      const q = url.searchParams;
      const out = sessions
        .filter((s) => (!q.get("persona") || s.persona_id === q.get("persona")) && (!q.get("status") || s.status === q.get("status")))
        .map((s) => ({ ...s, panel_locked_by: locks.get(s.id) }));
      return json(200, { sessions: out });
    }

    if (seg.length >= 4 && seg[2] === "sessions") {
      const id = seg[3]!;
      const sub = seg[4];
      const row = sessions.find((s) => s.id === id);
      if (!row) return json(404, { error: "session not found" });
      const me = op(req);

      if (!sub) return json(200, { session: row, panel_locked_by: locks.get(id) });
      if (sub === "events") return NO_REDIS ? json(503, { error: "no redis" }) : sseReplay(id);

      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      if (sub === "control") {
        if (body.action === "stop" && NO_REDIS) return json(503, { error: "stop unavailable (no Redis)" });
        if (body.action === "model" && body.model) row.model = body.model;
        return json(200, { ok: true, session: { ...row } });
      }
      if (sub === "chat") {
        if (NO_REDIS) return json(503, { error: "unavailable (no Redis)" });
        const owner = locks.get(id);
        if (owner && owner !== me) return json(409, { error: "driven by another operator", owner });
        locks.set(id, me);
        return json(202, { ok: true, locked_by: me });
      }
      if (sub === "lock") {
        if (NO_REDIS) return json(503, { error: "lock unavailable (no Redis)" });
        const owner = locks.get(id);
        if (owner && owner !== me) return json(409, { error: "held by another operator", owner });
        locks.set(id, me);
        return json(200, { ok: true, locked_by: me, ttl_ms: 45000 });
      }
      if (sub === "heartbeat") return json(200, { ok: true, ttl_ms: 45000 });
      if (sub === "release") { locks.delete(id); return json(200, { ok: true, released: true }); }
      if (sub === "force-release") { const d = locks.get(id); locks.set(id, me); return json(200, { ok: true, displaced: d }); }
    }
    return json(404, { error: "not found" });
  },
});

console.log(`[stub] panel fixture server on http://localhost:${PORT}/panel/ (noRedis=${NO_REDIS})`);
