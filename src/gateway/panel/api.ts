/**
 * Panel HTTP surface (design §2 + §3 + Refinements 1 & 2). Owns every
 * `/panel/*` path: the operator REST API under `/panel/api/*` and the static
 * web app everywhere else. Built inside createGateway so it closes over the
 * live registry / pubsub / dispatch seam; mounted on the gateway Bun.serve for
 * mono / gateway roles (never node).
 *
 * Auth: every request is gated by the SSO/ingress operator header
 * (./auth). Boot guard: without SLAUDE_PANEL_TRUST_HEADER the panel refuses to
 * serve at all (fail-closed against an ingress-less deploy).
 *
 * Control ops call the db functions directly (Refinement 1) — NOT the `/v1`
 * PATCH, which is job-token-scoped to a single session. Chat routes through the
 * gateway's unified enqueue seam (Refinement 2): the queue in the gateway role,
 * the in-process AgentManager in mono.
 *
 *   GET  /panel/api/sessions                     list ∩ warm registry
 *   GET  /panel/api/sessions/:id                 one row + lock owner
 *   GET  /panel/api/sessions/:id/events          SSE tail of events:<id>
 *   POST /panel/api/sessions/:id/chat            { text }        (acquires lock)
 *   POST /panel/api/sessions/:id/control         { action, ... }
 *   POST /panel/api/sessions/:id/lock            take control
 *   POST /panel/api/sessions/:id/heartbeat       refresh lock TTL
 *   POST /panel/api/sessions/:id/release         release control
 *   POST /panel/api/sessions/:id/force-release   steal + audit
 */
import { z } from "zod";
import { env } from "../../config/env";
import * as Sessions from "../../db/sessions";
import * as OneOnOne from "../../db/one-on-one";
import type { SessionRow } from "../../db/schema";
import type { Registry } from "../../queue/registry";
import type { PubSub } from "../../queue/pubsub";
import type { PanelLock } from "../../queue/panel-lock";
import { authenticateOperator } from "./auth";
import { enumerateSessions } from "./enumerator";
import { servePanelStatic } from "./static";

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Anti-CSRF guard for state-changing requests. The panel authenticates via an
 * ingress-injected identity header, which the browser attaches to ANY request
 * to this origin — including one forged by a cross-site page — so the header
 * alone cannot prove same-origin intent. GET/HEAD are safe (no state change).
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

const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"] as const;

const controlSchema = z
  .object({
    action: z.enum(["stop", "reset", "model", "mode", "unlock-1on1"]),
    model: z.string().min(1).optional(),
    mode: z.enum(PERMISSION_MODES).optional(),
  })
  .strict();

const chatSchema = z.object({ text: z.string().min(1) }).strict();

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
  /** SSE poll cadence (ms). Default 300. */
  eventsPollMs?: number;
}

/** Structured audit line for every operator action (design §Audit). */
function audit(operatorId: string, action: string, sessionId: string, extra?: Record<string, unknown>) {
  console.log(
    `[panel-audit] operator=${operatorId} action=${action} session=${sessionId} ts=${Date.now()}` +
      (extra ? ` ${JSON.stringify(extra)}` : ""),
  );
}

export interface PanelApi {
  /** Handle a request; null when the path is not under /panel (caller falls through). */
  fetch(req: Request): Promise<Response | null>;
}

export function createPanelApi(deps: PanelApiDeps): PanelApi {
  const pollMs = deps.eventsPollMs ?? 300;

  async function handleEvents(req: Request, sessionId: string): Promise<Response> {
    if (!deps.pubsub) return json(503, { error: "event stream unavailable (no Redis)" });
    const pubsub = deps.pubsub;
    const url = new URL(req.url);
    let lastId = req.headers.get("last-event-id") || url.searchParams.get("lastId") || undefined;
    if (!lastId) {
      // Skip backlog: seed from the newest entry so the operator sees live
      // events, not a replay of earlier turns (dispatch follower pattern).
      try {
        lastId = (await pubsub.readEvents(sessionId)).at(-1)?.id;
      } catch {
        /* stream may not exist yet — start from the beginning */
      }
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
                if (!send(`id: ${entry.id}\ndata: ${JSON.stringify(entry.event)}\n\n`)) break;
              }
            } catch (e) {
              console.error(`[panel] SSE read failed session=${sessionId}:`, e);
            }
            if (closed) break;
            // Heartbeat comment keeps intermediaries from closing an idle stream.
            send(": ping\n\n");
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

  async function handleControl(req: Request, row: SessionRow, operatorId: string): Promise<Response> {
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
        await OneOnOne.unlock(row.slack_channel_id, row.slack_thread_ts);
        break;
      }
    }
    audit(operatorId, `control:${action}`, row.id, { model, mode });
    const fresh = await Sessions.findById(row.id);
    return json(200, { ok: true, session: fresh });
  }

  async function fetch(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (url.pathname !== "/panel" && !url.pathname.startsWith("/panel/")) return null;

    // Boot guard (fail-closed): refuse to serve without an explicit
    // acknowledgement that an SSO/ingress fronts the panel.
    if (!env.panel.trustHeader()) {
      return json(500, {
        error: "panel refuses to serve: set SLAUDE_PANEL_TRUST_HEADER=1 only behind an SSO/ingress",
      });
    }

    const seg = url.pathname.split("/").filter(Boolean); // ["panel", ...]

    // Static web app: any /panel path that is not the API.
    if (seg[1] !== "api") {
      // Even static assets require a vouched operator — the whole surface is
      // behind ingress.
      const auth = authenticateOperator(req);
      if (!auth.ok) return auth.response;
      return (await servePanelStatic(url.pathname)) ?? json(404, { error: "not found" });
    }

    const auth = authenticateOperator(req);
    if (!auth.ok) return auth.response;
    const operatorId = auth.operatorId;

    // CSRF: block forged cross-site state changes before any mutating handler.
    const csrf = enforceCsrf(req);
    if (csrf) return csrf;

    try {
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
            panelOwner: deps.panelLock ? (id) => deps.panelLock!.owner(id) : undefined,
          },
        );
        return json(200, { sessions });
      }

      // /panel/api/sessions/:id[/sub]
      if (seg.length >= 4 && seg[2] === "sessions") {
        const id = seg[3]!;
        const sub = seg[4];
        const row = await Sessions.findById(id);
        if (!row) return json(404, { error: "session not found" });

        // GET /panel/api/sessions/:id
        if (!sub) {
          if (req.method !== "GET") return json(405, { error: "method not allowed" });
          const lockedBy = deps.panelLock ? await deps.panelLock.owner(id) : null;
          // TODO(transcript): the durable SDK transcript read from the RWX
          // volume (design §2) attaches here as `transcript`; the live tail is
          // the SSE endpoint. Left for the UI-driven follow-up.
          return json(200, { session: row, panel_locked_by: lockedBy ?? undefined });
        }

        // GET /panel/api/sessions/:id/events  (SSE)
        if (sub === "events") {
          if (req.method !== "GET") return json(405, { error: "method not allowed" });
          return await handleEvents(req, id);
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
            audit(operatorId, "chat", id);
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
          audit(operatorId, "chat", id);
          await deps.chat(row, parsed.data.text, operatorId);
          return json(202, { ok: true });
        }

        // POST /panel/api/sessions/:id/control
        if (sub === "control") {
          if (req.method !== "POST") return json(405, { error: "method not allowed" });
          return await handleControl(req, row, operatorId);
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
          audit(operatorId, "lock", id);
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
            audit(operatorId, "release", id);
            await deps.onLockReleased?.(id);
          }
          return json(200, { ok: true, released });
        }

        // POST /panel/api/sessions/:id/force-release  (STEAL a contended lock)
        if (sub === "force-release") {
          if (req.method !== "POST") return json(405, { error: "method not allowed" });
          if (!deps.panelLock) return json(503, { error: "lock unavailable (no Redis)" });
          // F4: force-release transfers control to the CALLER — it does not
          // hand the session back to Slack. The lock stays held under the new
          // owner (Slack still suppressed), the displaced operator's heartbeat
          // starts failing (they lost control), and the caller drives.
          const displaced = await deps.panelLock.steal(id, operatorId);
          deps.onLockHeld?.(id, operatorId, deps.panelLock.ttlMs);
          audit(operatorId, "force-release", id, { displaced: displaced ?? null, newOwner: operatorId });
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
