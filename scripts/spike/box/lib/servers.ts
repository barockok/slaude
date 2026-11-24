/**
 * Host-side servers for the box spikes (Spike 3 and 4). Spike code, never production code.
 *
 *  - startFakeUpstream: a stand-in for the model provider. It only accepts the REAL credential for the
 *    form under test, and records every request (method, path, header names, whether any header value
 *    contained the placeholder).
 *  - startProviderProxy: a reverse proxy on a Unix socket that strips the inbound credential headers,
 *    adds the real credential, streams both ways, and never follows a redirect.
 *  - startEgressProxy: an HTTP CONNECT proxy on a Unix socket with an EMPTY allowlist: it logs every
 *    CONNECT / absolute-URI request and answers 403 with a message an agent can read.
 */
import { createServer, type Server } from "node:net";
import { chmodSync, existsSync, unlinkSync } from "node:fs";

export type Form = "A" | "B" | "C"; // A: x-api-key, B: authorization bearer (auth token), C: authorization bearer (oauth token)

export interface Seen {
  t: number;
  method: string;
  path: string;
  headerNames: string[];
  credHeader: "x-api-key" | "authorization" | "none";
  credOk: boolean;
  placeholderInHeaders: boolean;
  model: string | undefined;
  scenario: string;
}

export interface Upstream {
  url: string;
  seen: Seen[];
  setCredential(c: string): void;
  stop(): void;
}

function sse(events: Array<[string, unknown]>): string {
  return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
}

function userTexts(body: { messages?: Array<{ role: string; content: unknown }> }): { all: string; first: string; toolResults: number; lastHasToolResult: boolean } {
  let all = "";
  let first = "";
  let toolResults = 0;
  let lastHasToolResult = false;
  const ms = body.messages ?? [];
  ms.forEach((m, idx) => {
    if (m.role !== "user") return;
    const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as Array<Record<string, unknown>>);
    let hasTr = false;
    for (const b of parts) {
      if (b.type === "text" && typeof b.text === "string") {
        if (!first) first = b.text;
        all += b.text + "\n";
      }
      if (b.type === "tool_result") {
        toolResults++;
        hasTr = true;
      }
    }
    if (idx === ms.length - 1) lastHasToolResult = hasTr;
  });
  return { all, first, toolResults, lastHasToolResult };
}

function text(model: string, n: number, t: string): string {
  return sse([
    ["message_start", { type: "message_start", message: { id: `msg_${n}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t.slice(0, Math.ceil(t.length / 2)) } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t.slice(Math.ceil(t.length / 2)) } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }],
    ["message_stop", { type: "message_stop" }],
  ]);
}

function thinking(model: string, n: number, t: string): string {
  return sse([
    ["message_start", { type: "message_start", message: { id: `msg_${n}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "let me think about this" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "c3Bpa2Utc2ln" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: t } }],
    ["content_block_stop", { type: "content_block_stop", index: 1 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 9 } }],
    ["message_stop", { type: "message_stop" }],
  ]);
}

function tool(model: string, n: number, name: string, input: Record<string, unknown>): string {
  return sse([
    ["message_start", { type: "message_start", message: { id: `msg_${n}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${n}`, name, input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } }],
    ["message_stop", { type: "message_stop" }],
  ]);
}

type Step = [string, Record<string, unknown>];
const SCRIPTS: Record<string, Step[]> = {
  TOOLLOOP: [
    ["Bash", { command: "echo step-one", description: "spike step" }],
    ["Bash", { command: "echo step-two > loop.txt && cat loop.txt", description: "spike step" }],
    ["Bash", { command: "ls | head -3", description: "spike step" }],
  ],
  TOUCH: [["Bash", { command: "touch touched.marker", description: "spike touch" }]],
  SLEEP: [["Bash", { command: "sleep 60", description: "spike sleep" }]],
  MCPCALL: [["mcp__spike__echo", { text: "hello-from-model" }]],
  STDIOMCP: [["mcp__stdiospike__echo", { text: "hello-stdio" }]],
  TURN10: [
    ["Bash", { command: "mkdir -p /work/t10 && echo 'export const f = (x: number) => x + 1;' > /work/t10/a.ts", description: "setup" }],
    ["Read", { file_path: "/work/t10/a.ts" }],
    ["Write", { file_path: "/work/t10/a.test.ts", content: "import { test, expect } from 'bun:test';\nimport { f } from './a';\ntest('f', () => { expect(f(1)).toBe(3); });\n" }],
    ["Bash", { command: "cd /work/t10 && bun test 2>&1 | tail -5; true", description: "run tests" }],
    ["Edit", { file_path: "/work/t10/a.ts", old_string: "x + 1", new_string: "x + 2" }],
    ["Bash", { command: "cd /work/t10 && bun test 2>&1 | tail -5", description: "run tests" }],
    ["Read", { file_path: "/work/t10/a.ts" }],
    ["Bash", { command: "ls -la /work/t10", description: "list" }],
    ["Bash", { command: "wc -l /work/t10/*.ts", description: "count" }],
    ["Bash", { command: "cat /work/t10/a.test.ts | head -3", description: "show" }],
  ],
};

/** The scripted behaviour, a pure function of the conversation so a resumed or compacted session still works. */
export function scenario(body: Record<string, unknown>, n: number): { name: string; sse: string } {
  const model = (body.model as string) ?? "claude-test";
  const u = userTexts(body as { messages?: Array<{ role: string; content: unknown }> });
  const tools = (body.tools as unknown[] | undefined) ?? [];
  if (tools.length === 0) return { name: "side-request-text", sse: text(model, n, "<summary>spike summary</summary>") };
  if (u.first.includes("SUBTASK")) return { name: "subagent-body", sse: text(model, n, "sub done") };
  if (u.all.includes("SUBAGENT")) {
    if (u.toolResults === 0) return { name: "subagent-call", sse: tool(model, n, "Task", { description: "spike subtask", prompt: "SUBTASK do the thing", subagent_type: "general-purpose" }) };
    return { name: "subagent-final", sse: text(model, n, "main done") };
  }
  for (const k of Object.keys(SCRIPTS)) {
    if (!u.all.includes(k)) continue;
    const steps = SCRIPTS[k]!;
    if (u.toolResults < steps.length) {
      const [name, input] = steps[u.toolResults]!;
      return { name: `${k.toLowerCase()}-step${u.toolResults}`, sse: tool(model, n, name, input) };
    }
    return { name: `${k.toLowerCase()}-final`, sse: text(model, n, k === "TOOLLOOP" ? "loop done" : `${k.toLowerCase()} done`) };
  }
  if (u.all.includes("THINKING")) return { name: "thinking", sse: thinking(model, n, "thought done") };
  return { name: "plain", sse: text(model, n, "plain reply") };
}

export function startFakeUpstream(form: Form, realCredential: string, placeholder: string): Upstream {
  let cred = realCredential;
  const seen: Seen[] = [];
  let n = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const names = [...req.headers.keys()].sort();
      const joined = [...req.headers.values()].join("\n");
      const xk = req.headers.get("x-api-key");
      const au = req.headers.get("authorization");
      const credHeader: Seen["credHeader"] = xk ? "x-api-key" : au ? "authorization" : "none";
      const credOk = form === "A" ? xk === cred : au === `Bearer ${cred}`;
      const rec: Seen = { t: Date.now(), method: req.method, path: u.pathname + u.search, headerNames: names, credHeader, credOk, placeholderInHeaders: joined.includes(placeholder), model: undefined, scenario: "-" };
      seen.push(rec);
      if (!u.pathname.endsWith("/v1/messages") || req.method !== "POST") {
        if (u.pathname.endsWith("/v1/messages/count_tokens")) return Response.json({ input_tokens: 10 });
        return Response.json({ error: "not found" }, { status: 404 });
      }
      if (!credOk) return Response.json({ type: "error", error: { type: "authentication_error", message: "invalid credential" } }, { status: 401 });
      const body = (await req.json()) as Record<string, unknown>;
      rec.model = body.model as string | undefined;
      n++;
      const sc = scenario(body, n);
      rec.scenario = sc.name;
      return new Response(sc.sse, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, seen, setCredential: (c) => (cred = c), stop: () => server.stop(true) };
}

export interface ProxyStats {
  requests: Array<{ method: string; path: string; headerNamesIn: string[]; credHeaderIn: string; status: number; bytesOut: number }>;
  redirectsRefused: number;
}

const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length"]);
const CRED_HEADERS = new Set(["x-api-key", "authorization", "anthropic-auth-token", "cookie"]);

export function startProviderProxy(sock: string, upstream: string, form: Form, getCredential: () => string): { stats: ProxyStats; stop(): void } {
  if (existsSync(sock)) unlinkSync(sock);
  const stats: ProxyStats = { requests: [], redirectsRefused: 0 };
  const server = Bun.serve({ // unix sockets are a Bun option the stable typings lag behind

    unix: sock,
    idleTimeout: 120,
    async fetch(req: Request) {
      const u = new URL(req.url);
      const h = new Headers();
      for (const [k, v] of req.headers) if (!HOP.has(k) && !CRED_HEADERS.has(k)) h.set(k, v);
      const credIn = req.headers.has("x-api-key") ? "x-api-key" : req.headers.has("authorization") ? "authorization" : "none";
      if (form === "A") h.set("x-api-key", getCredential());
      else h.set("authorization", `Bearer ${getCredential()}`);
      let r: Response;
      try {
        r = await fetch(upstream + u.pathname + u.search, { method: req.method, headers: h, body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body, redirect: "manual", duplex: "half" } as RequestInit);
      } catch (e) {
        stats.requests.push({ method: req.method, path: u.pathname, headerNamesIn: [...req.headers.keys()].sort(), credHeaderIn: credIn, status: 502, bytesOut: 0 });
        return new Response(`provider proxy: upstream unreachable`, { status: 502 });
      }
      if (r.status >= 300 && r.status < 400) {
        stats.redirectsRefused++;
        stats.requests.push({ method: req.method, path: u.pathname, headerNamesIn: [...req.headers.keys()].sort(), credHeaderIn: credIn, status: 502, bytesOut: 0 });
        return new Response("provider proxy: redirect refused", { status: 502 });
      }
      const oh = new Headers();
      for (const [k, v] of r.headers) if (!HOP.has(k) && !CRED_HEADERS.has(k) && k !== "content-encoding") oh.set(k, v);
      stats.requests.push({ method: req.method, path: u.pathname, headerNamesIn: [...req.headers.keys()].sort(), credHeaderIn: credIn, status: r.status, bytesOut: 0 });
      return new Response(r.body, { status: r.status, headers: oh });
    },
  } as never);
  chmodSync(sock, 0o666);
  return { stats, stop: () => (server as { stop(f: boolean): void }).stop(true) };
}

export interface EgressLog {
  lines: string[];
}

export function startEgressProxy(sock: string, allow: string[] = []): { log: EgressLog; stop(): void } {
  if (existsSync(sock)) unlinkSync(sock);
  const log: EgressLog = { lines: [] };
  const srv: Server = createServer((c) => {
    let buf = Buffer.alloc(0);
    const onData = async (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      c.off("data", onData);
      c.pause();
      const head = buf.subarray(0, end).toString("latin1");
      const first = head.split("\r\n")[0] ?? "";
      const [method, target] = first.split(" ");
      const host = (method === "CONNECT" ? target : new URL(target ?? "http://x/").host) ?? "";
      const hostOnly = host.split(":")[0] ?? "";
      const allowed = allow.includes(hostOnly) || allow.includes(host);
      log.lines.push(`${allowed ? "ALLOW" : "DENY"} ${first}`);
      if (!allowed || method !== "CONNECT") {
        const body = `egress refused: ${hostOnly || "?"} is not on this persona's allowlist. Ask the owner to add it in the deploy repo.\n`;
        c.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
        return;
      }
      const [h, p] = host.split(":");
      const up = (await import("node:net")).connect(Number(p ?? 443), h);
      up.on("error", () => c.destroy());
      c.on("error", () => up.destroy());
      up.on("connect", () => {
        c.write("HTTP/1.1 200 Connection established\r\n\r\n");
        const rest = buf.subarray(end + 4);
        if (rest.length) up.write(rest);
        c.pipe(up);
        up.pipe(c);
        c.resume();
      });
    };
    c.on("data", onData);
    c.on("error", () => {});
  });
  srv.listen(sock, () => chmodSync(sock, 0o666));
  return { log, stop: () => srv.close() };
}
