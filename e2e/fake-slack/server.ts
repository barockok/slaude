import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { CallLog } from "./core/call-log";
import { blockActionsPayload, deliverEvent, deliverInteraction, messageEnvelope, type DeliverOptions } from "./core/inbound";
import { FaultStore, createWebApi, parseParams } from "./core/web-api";
import { SlackError, Workspace, type FakeMessage } from "./core/workspace";

export interface FakeSlack {
  url: string;
  port: number;
  ws: Workspace;
  log: CallLog;
  faults: FaultStore;
  stop(): Promise<void>;
}

export interface FakeSlackOptions {
  port?: number;
  host?: string;
  teamId?: string;
  /** Where gateways reach the fake (used for response_url). Default http://127.0.0.1:<port>. */
  publicUrl?: string;
  retryDelaysMs?: number[];
  ackTimeoutMs?: number;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type FieldKind = "string" | "string?" | "boolean?" | "int?" | "target" | "delays?" | "ms?";

const OPTIONAL_SEND: Record<string, FieldKind> = { threadTs: "string?", eventId: "string?", mention: "boolean?", duplicate: "boolean?", retryNum: "int?" };
const DELIVERY: Record<string, FieldKind> = { retryDelaysMs: "delays?", ackTimeoutMs: "ms?" };

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function fieldOk(kind: FieldKind, v: unknown): boolean {
  switch (kind) {
    case "string":
      return typeof v === "string";
    case "string?":
      return v === undefined || typeof v === "string";
    case "boolean?":
      return v === undefined || typeof v === "boolean";
    case "int?":
      return v === undefined || (Number.isInteger(v) && (v as number) >= 0);
    case "ms?":
      return v === undefined || (isFiniteNumber(v) && v > 0);
    case "delays?":
      return v === undefined || (Array.isArray(v) && v.length <= 10 && v.every((d) => isFiniteNumber(d) && d >= 0));
    case "target": {
      if (typeof v !== "string") return false;
      try {
        const u = new URL(v);
        return u.protocol === "http:" || u.protocol === "https:";
      } catch {
        return false;
      }
    }
  }
}

/** Check a control body against a field spec before any side effect; a failure is a 400 naming the field. */
function validate(body: Record<string, any>, spec: Record<string, FieldKind>): Record<string, any> {
  for (const [name, kind] of Object.entries(spec)) {
    if (!fieldOk(kind, body[name])) throw new HttpError(400, `invalid_arguments: ${name}`);
  }
  return { ...body, target: typeof body.target === "string" ? body.target.replace(/\/+$/, "") : body.target };
}

function deliveryOverrides(a: Record<string, any>): Pick<DeliverOptions, "retryDelaysMs" | "ackTimeoutMs"> {
  const out: Pick<DeliverOptions, "retryDelaysMs" | "ackTimeoutMs"> = {};
  if (a.retryDelaysMs !== undefined) out.retryDelaysMs = a.retryDelaysMs;
  if (a.ackTimeoutMs !== undefined) out.ackTimeoutMs = a.ackTimeoutMs;
  return out;
}

export async function startFakeSlack(opts: FakeSlackOptions = {}): Promise<FakeSlack> {
  const ws = new Workspace(opts.teamId ?? "T0FAKE");
  const log = new CallLog();
  const faults = new FaultStore();
  const api = createWebApi(ws, log, faults);
  let publicUrl = opts.publicUrl?.replace(/\/+$/, "") ?? "";
  const deliverOpts: DeliverOptions = { retryDelaysMs: opts.retryDelaysMs, ackTimeoutMs: opts.ackTimeoutMs };

  const appOf = (id: unknown) => {
    const app = typeof id === "string" ? ws.apps.get(id) : undefined;
    if (!app) throw new HttpError(404, `unknown app ${String(id)}`);
    return app;
  };
  const channelOf = (id: unknown) => {
    if (typeof id !== "string" || !ws.channels.has(id)) throw new HttpError(404, "channel_not_found");
    return id;
  };
  const view = (m: { ts: string; user: string; text: string; blocks?: unknown; threadTs?: string }) => ({
    ts: m.ts,
    user: m.user,
    text: m.text,
    blocks: m.blocks,
    threadTs: m.threadTs,
  });

  async function control(req: http.IncomingMessage, res: http.ServerResponse, route: string, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    const raw = method === "GET" || method === "DELETE" ? "" : await readBody(req);
    let body: Record<string, any> = {};
    if (raw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new HttpError(400, "body is not JSON");
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new HttpError(400, "invalid_arguments: body");
      body = parsed as Record<string, any>;
    }
    switch (`${method} ${route}`) {
      case "POST users":
        return send(res, 200, ws.addUser(body.id, body.name));
      case "POST apps":
        return send(res, 200, ws.addApp(body as any));
      case "GET apps":
        return send(res, 200, { apps: [...ws.apps.values()] });
      case "POST channels":
        return send(res, 200, { ...ws.addChannel(body as any), members: ws.members(body.id) });
      /**
       * Posts a human message, then delivers its event to `target` the way Slack does, retrying on failure.
       * COST: a down or slow target blocks this request for the whole retry schedule
       * (0 + 60000 + 300000 ms by default, twice that with `duplicate`). Pass a short `retryDelaysMs`
       * (and `ackTimeoutMs`) per request, or start the fake with short delays, when the target may be down.
       *
       * With `redeliverTs`, nothing is posted: the EXISTING message with that ts is delivered again
       * (under `eventId`, or a fresh one), the way Slack can deliver one message as two events.
       * `text`, `threadTs` and `mention` describe a new message, so they are rejected there, and
       * `user` must be the stored message's author.
       */
      case "POST send": {
        const redeliver = body.redeliverTs !== undefined;
        const a = validate(body, {
          app: "string",
          channel: "string",
          user: "string",
          ...(redeliver ? { redeliverTs: "string" } : { text: "string" }),
          target: "target",
          ...OPTIONAL_SEND,
          ...DELIVERY,
        });
        const app = appOf(a.app);
        const channel = channelOf(a.channel);
        let msg: FakeMessage;
        if (redeliver) {
          for (const k of ["text", "threadTs", "mention"]) if (a[k] !== undefined) throw new HttpError(400, `invalid_arguments: ${k}`);
          const stored = ws.message(channel, a.redeliverTs);
          if (!stored) throw new HttpError(404, "message_not_found");
          if (stored.user !== a.user) throw new HttpError(400, "invalid_arguments: user");
          msg = stored;
        } else {
          const text = `${a.mention ? `<@${app.botUserId}> ` : ""}${a.text}`;
          msg = ws.post({ channel, user: a.user, text, threadTs: a.threadTs });
        }
        const envelope = messageEnvelope(ws, app, msg, { eventId: a.eventId });
        const o = { ...deliverOpts, ...deliveryOverrides(a), retryNum: a.retryNum };
        const eventsUrl = `${a.target}/slack/events`;
        const deliveries = [await deliverEvent(eventsUrl, app.signingSecret, envelope, o)];
        if (a.duplicate) deliveries.push(await deliverEvent(eventsUrl, app.signingSecret, envelope, o));
        log.add({ kind: "inbound", method: "events", app: app.apiAppId, ok: true, status: 200, detail: { ts: msg.ts, channel, deliveries: deliveries.length } });
        return send(res, 200, { message: { ts: msg.ts, channel, threadTs: msg.threadTs }, deliveries });
      }
      case "POST click": {
        const a = validate(body, { app: "string", user: "string", channel: "string", messageTs: "string", actionId: "string", target: "target", value: "string?", ...DELIVERY });
        const app = appOf(a.app);
        const payload = blockActionsPayload({
          ws,
          app,
          user: a.user,
          channel: channelOf(a.channel),
          messageTs: a.messageTs,
          actionId: a.actionId,
          value: a.value,
          responseUrl: `${publicUrl}/response/${randomBytes(6).toString("hex")}`,
        });
        const delivery = await deliverInteraction(`${a.target}/slack/interactions`, app.signingSecret, payload, { ...deliverOpts, ...deliveryOverrides(a) });
        log.add({ kind: "inbound", method: "interactions", app: app.apiAppId, ok: true, status: 200, detail: { actionId: a.actionId } });
        return send(res, 200, { delivery });
      }
      case "GET thread":
        return send(res, 200, { messages: ws.replies(url.searchParams.get("channel") ?? "", url.searchParams.get("threadTs") ?? "").map(view) });
      case "GET messages":
        return send(res, 200, { messages: ws.messages(url.searchParams.get("channel") ?? "").map(view) });
      case "GET calls": {
        const m = url.searchParams.get("method");
        const since = Number(url.searchParams.get("since") ?? 0);
        return send(res, 200, { calls: log.where((r) => (!m || r.method === m) && r.seq > since) });
      }
      case "DELETE calls":
        log.clear();
        return send(res, 200, { ok: true });
      case "POST faults":
        faults.add(body as any);
        return send(res, 200, { ok: true });
      case "DELETE faults":
        faults.clear();
        return send(res, 200, { ok: true });
      case "POST reset": {
        log.clear();
        faults.clear();
        for (const id of ws.channels.keys()) for (const m of ws.messages(id)) ws.remove(id, m.ts);
        return send(res, 200, { ok: true });
      }
      default:
        throw new HttpError(404, `no control route ${method} ${route}`);
    }
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake");
    const path = url.pathname;
    if (path === "/healthz") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    if (path.startsWith("/api/") && req.method === "POST") {
      const method = path.slice("/api/".length);
      const raw = await readBody(req);
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? null;
      const r = api(method, parseParams(req.headers["content-type"] ?? null, raw), bearer);
      return send(res, r.status, r.body, r.headers);
    }
    if (path.startsWith("/response/") && req.method === "POST") {
      const raw = await readBody(req);
      let parsed: unknown = raw;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // keep the raw text
      }
      log.add({ kind: "response_url", method: "response_url", ok: true, status: 200, detail: { id: path.slice("/response/".length), body: parsed } });
      return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    }
    if (path.startsWith("/__fake/")) return control(req, res, path.slice("/__fake/".length), url);
    throw new HttpError(404, `no route ${req.method} ${path}`);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (res.headersSent) return void res.destroy();
      if (e instanceof HttpError) return send(res, e.status, { ok: false, error: e.message });
      if (e instanceof SlackError) return send(res, 400, { ok: false, error: e.code });
      send(res, 500, { ok: false, error: `fake-slack failure: ${String(e)}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? "0.0.0.0", resolve));
  const port = (server.address() as AddressInfo).port;
  if (!publicUrl) publicUrl = `http://127.0.0.1:${port}`;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    ws,
    log,
    faults,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
