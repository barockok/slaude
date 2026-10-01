import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { CallLog } from "./core/call-log";
import { blockActionsPayload, deliverEvent, deliverInteraction, messageEnvelope, type DeliverOptions } from "./core/inbound";
import { FaultStore, createWebApi, parseParams } from "./core/web-api";
import { SlackError, Workspace } from "./core/workspace";

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
      try {
        body = JSON.parse(raw);
      } catch {
        throw new HttpError(400, "body is not JSON");
      }
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
      case "POST send": {
        const app = appOf(body.app);
        const channel = channelOf(body.channel);
        const text = `${body.mention ? `<@${app.botUserId}> ` : ""}${body.text}`;
        const msg = ws.post({ channel, user: body.user, text, threadTs: body.threadTs });
        const envelope = messageEnvelope(ws, app, msg, { eventId: body.eventId });
        const o = { ...deliverOpts, retryNum: body.retryNum };
        const eventsUrl = `${body.target}/slack/events`;
        const deliveries = [await deliverEvent(eventsUrl, app.signingSecret, envelope, o)];
        if (body.duplicate) deliveries.push(await deliverEvent(eventsUrl, app.signingSecret, envelope, o));
        log.add({ kind: "inbound", method: "events", app: app.apiAppId, ok: true, status: 200, detail: { ts: msg.ts, channel, deliveries: deliveries.length } });
        return send(res, 200, { message: { ts: msg.ts, channel, threadTs: msg.threadTs }, deliveries });
      }
      case "POST click": {
        const app = appOf(body.app);
        const payload = blockActionsPayload({
          ws,
          app,
          user: body.user,
          channel: channelOf(body.channel),
          messageTs: body.messageTs,
          actionId: body.actionId,
          value: body.value,
          responseUrl: `${publicUrl}/response/${randomBytes(6).toString("hex")}`,
        });
        const delivery = await deliverInteraction(`${body.target}/slack/interactions`, app.signingSecret, payload, deliverOpts);
        log.add({ kind: "inbound", method: "interactions", app: app.apiAppId, ok: true, status: 200, detail: { actionId: body.actionId } });
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
