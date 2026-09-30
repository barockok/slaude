import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { LLMock } from "@copilotkit/aimock";
import type { FixtureResponse } from "@copilotkit/aimock";
import { errorBody, planFaults } from "./core/faults";
import type { FaultPlan } from "./core/faults";
import { resolveReply } from "./core/registry";
import { lastTagIn } from "./core/tag";
import type { MockReply, MockRequest } from "./core/types";

interface JournalRow {
  ts: number;
  method: string;
  path: string;
  retryCount: number;
  clientRetryCount: number;
  tag: string | null;
  action: string;
  messages: number;
  historyHash: string;
}

function toFixtureResponse(r: MockReply): FixtureResponse {
  if (r.kind === "tools") {
    return { toolCalls: r.calls.map((c) => ({ id: c.id, name: c.name, arguments: JSON.stringify(c.args) })) };
  }
  return r.reasoning ? { content: r.content, reasoning: r.reasoning } : { content: r.content };
}

/** Resolves after ms, or as soon as the client goes away. */
function delay(ms: number, res: http.ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      res.off("close", done);
      resolve();
    }
    res.once("close", done);
  });
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** Split an upstream byte stream into whole SSE events; a non-SSE body is one event. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      yield buf.slice(0, i + 2);
      buf = buf.slice(i + 2);
    }
  }
  buf += decoder.decode();
  if (buf) yield buf;
}

const HOP_HEADERS = new Set(["content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive"]);

function hash(body: string): string {
  let messages: unknown = body;
  try {
    messages = (JSON.parse(body) as { messages?: unknown }).messages ?? body;
  } catch {}
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex").slice(0, 16);
}

/** Attempt-counter key: the system prompt plus the history, so each persona counts on its own. */
function attemptKey(body: string): string {
  let basis: unknown = body;
  try {
    const b = JSON.parse(body) as { system?: unknown; messages?: unknown };
    basis = { system: b.system ?? null, messages: b.messages ?? null };
  } catch {}
  return createHash("sha256").update(JSON.stringify(basis)).digest("hex").slice(0, 16);
}

function messageCount(body: string): number {
  try {
    const m = (JSON.parse(body) as { messages?: unknown }).messages;
    return Array.isArray(m) ? m.length : 0;
  } catch {
    return 0;
  }
}

export async function startServer(port: number): Promise<{ port: number; stop(): Promise<void> }> {
  const mock = new LLMock({ port: 0, host: "127.0.0.1", logLevel: "warn", chunkSize: 16 });
  mock.on({ predicate: () => true }, (req) => toFixtureResponse(resolveReply(req as unknown as MockRequest)));
  const upstream = await mock.start();
  const journal: JournalRow[] = [];
  // Attempt counting is the one deliberate stateful exception: fault-only, it never changes reply
  // content. The counter is per (system prompt, history). With several mock replicas a retry may hit
  // another replica, so fault scenarios needing more than one attempt require a single replica or
  // client-IP affinity, and test prompts must be unique per case and per persona.
  const attempts = new Map<string, number>();
  const MAX_ATTEMPTS = 10_000;

  async function proxy(req: http.IncomingMessage, body: Buffer, res: http.ServerResponse, plan: FaultPlan): Promise<void> {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined && !HOP_HEADERS.has(k) && k !== "host") headers.set(k, Array.isArray(v) ? v.join(",") : v);
    }
    const up = await fetch(upstream + (req.url ?? "/"), {
      method: req.method,
      headers,
      body: body.length && req.method !== "GET" ? body : undefined,
    });
    const out: Record<string, string> = {};
    up.headers.forEach((v, k) => {
      if (!HOP_HEADERS.has(k)) out[k] = v;
    });
    res.writeHead(up.status, out);
    if (!up.body) {
      res.end();
      return;
    }
    let n = 0;
    for await (const ev of sseEvents(up.body)) {
      if (res.destroyed) return;
      if (plan.action === "drop" && n >= plan.dropAfterEvents) {
        // FIN, not RST: a destroy() can reset the connection before the client has read the
        // events already flushed. Ending the socket without the chunked terminator still reads
        // as a truncated stream.
        // Give the client a beat to consume the flushed events before the truncation lands;
        // otherwise Bun's fetch can drop the trailing event when the FIN arrives with it.
        await delay(50, res);
        if (res.socket) res.socket.end();
        else res.destroy();
        return;
      }
      if (plan.intervalMs && n > 0) await delay(plan.intervalMs, res);
      if (plan.action === "drop") await new Promise<void>((resolve) => res.write(ev, () => resolve()));
      else res.write(ev);
      n++;
    }
    res.end();
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0]!;
    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (path === "/__mock/journal") {
      if (req.method === "DELETE") {
        journal.length = 0;
        attempts.clear();
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(req.method === "DELETE" ? [] : journal));
      return;
    }
    if (path === "/v1/messages/count_tokens") {
      await readBody(req);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    const body = await readBody(req);
    if (path.startsWith("/__aimock")) {
      await proxy(req, body, res, planFaults(null, 0));
      return;
    }
    const text = body.toString("utf8");
    const tag = lastTagIn(text);
    const clientRetryCount = Number.parseInt(String(req.headers["x-stainless-retry-count"] ?? "0"), 10) || 0;
    const historyHash = hash(text);
    const key = attemptKey(text);
    const retryCount = attempts.get(key) ?? 0;
    const plan = planFaults(tag, retryCount);
    attempts.delete(key);
    attempts.set(key, retryCount + 1);
    if (attempts.size > MAX_ATTEMPTS) attempts.delete(attempts.keys().next().value as string);
    journal.push({
      ts: Date.now(),
      method: req.method ?? "GET",
      path,
      retryCount,
      clientRetryCount,
      tag: tag?.name ?? null,
      action: plan.action,
      messages: messageCount(text),
      historyHash,
    });
    if (plan.delayMs) await delay(plan.delayMs, res);
    if (res.destroyed) return;
    switch (plan.action) {
      case "hang":
        await new Promise<void>((resolve) => res.once("close", resolve));
        return;
      case "error":
        res.writeHead(plan.status, { "content-type": "application/json" }).end(JSON.stringify(errorBody(plan.status)));
        return;
      case "malformed":
        res.writeHead(200, { "content-type": "text/event-stream" }).end("event: message_start\ndata: {not json\n\n");
        return;
      default:
        await proxy(req, body, res, plan);
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `mock failure: ${String(e)}` } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "0.0.0.0", resolve));

  return {
    port: (server.address() as AddressInfo).port,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await mock.stop();
    },
  };
}
