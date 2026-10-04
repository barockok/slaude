/**
 * A real (if small) MCP server over streamable HTTP for the bridge tests:
 * stateful sessions, SSE or JSON responses, raw JSON Schema tool definitions
 * (no zod in between, so a definition can be compared byte for byte), and
 * records of what reached it — the Authorization header per request, the
 * cancellations, and the calls whose HTTP request was dropped.
 *
 * The repo's deploy/k8s-local/mock-mcp answers `{}` and is not an MCP server.
 */
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export const INSTRUCTIONS = "Use these tools for the example service. Prefer echo for checks.";

/** Raw definitions, deliberately awkward: $defs, oneOf, enums, annotations,
 *  an outputSchema and an _meta field. */
export const TOOLS = [
  {
    name: "echo",
    title: "Echo",
    description: "Echo the text back.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "nested",
    description: "A complex, nested schema.",
    inputSchema: {
      type: "object",
      $defs: { point: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } },
      properties: {
        mode: { type: "string", enum: ["fast", "slow"], default: "fast" },
        shape: {
          oneOf: [
            { type: "object", properties: { kind: { const: "circle" }, r: { type: "number", minimum: 0 } }, required: ["kind", "r"] },
            { type: "object", properties: { kind: { const: "poly" }, points: { type: "array", items: { $ref: "#/$defs/point" }, minItems: 3 } }, required: ["kind", "points"] },
          ],
        },
        tags: { type: "array", items: { type: "string" }, uniqueItems: true },
      },
      required: ["shape"],
      additionalProperties: false,
    },
    _meta: { "example/flag": true },
  },
  {
    name: "structured",
    description: "Returns structured content.",
    inputSchema: { type: "object", properties: { n: { type: "integer" } } },
    outputSchema: { type: "object", properties: { doubled: { type: "integer" } }, required: ["doubled"] },
  },
  { name: "image", description: "Returns an image.", inputSchema: { type: "object", properties: {} } },
  { name: "fail", description: "Always a tool error.", inputSchema: { type: "object", properties: {} } },
  { name: "big", description: "Returns n bytes.", inputSchema: { type: "object", properties: { n: { type: "integer" } } } },
  { name: "slow", description: "Waits until cancelled.", inputSchema: { type: "object", properties: {} } },
  { name: "whoami", description: "Returns the Authorization header it saw.", inputSchema: { type: "object", properties: {} } },
] as const;

export const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

export interface Upstream {
  url: string;
  port: number;
  /** Authorization header of every HTTP request, in order. */
  auths: (string | null)[];
  /** Per HTTP request: the Authorization and x-api-key headers and the query string. */
  seen: { auth: string | null; apiKey: string | null; search: string }[];
  /** JSON-RPC methods received, in order. */
  methods: string[];
  /** requestIds the client cancelled with notifications/cancelled. */
  cancelled: unknown[];
  /** `slow` calls whose handler saw the cancellation. */
  slowAborted: number;
  /** Paths requested (to prove a redirect was not followed). */
  paths: string[];
  /** HTTP methods, in order (a GET would be the standalone SSE stream). */
  verbs: string[];
  /** Bearer values the server refuses with 401 (and a body that must not leak). */
  refuse: Set<string>;
  /** Bearer values the server refuses with 403 (permission denied). */
  forbid: Set<string>;
  /** POST requests whose connection the client dropped before the response ended. */
  httpAborts: number;
  /** Fault tools run, by name: `fault_502` (runs, then answers 502) and
   *  `fault_drop` (runs, then the response body breaks off). */
  executed: Record<string, number>;
  /** DELETE requests whose connection the client dropped (with `hangDelete`). */
  deleteAborts: number;
  /** A restart: every session is forgotten (like expireSessions). */
  restart(): void;
  /** Drop every session: the next request on an old session id gets 404. */
  expireSessions(): void;
  sessions(): number;
  stop(): void;
}

export const LEAKY_BODY = "upstream-secret-detail: token=leak-me-not";

export function startUpstream(
  opts: {
    json?: boolean;
    redirectTo?: string;
    /** The status for a session id the server does not know. Default 404 (the spec); many servers send 400, some 500. */
    unknownSessionStatus?: 400 | 404 | 500;
    /** Runs before each `initialize` POST is handled, with its 1-based ordinal:
     *  may delay it, or answer it with its own Response instead. */
    onInitialize?: (n: number) => Promise<Response | void>;
    /** Never answer a DELETE (session termination). */
    hangDelete?: boolean;
    /** Extra generated tools after TOOLS, and tools/list page size (default: one page). */
    extraTools?: number;
    pageSize?: number;
  } = {},
): Upstream {
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const state: Omit<Upstream, "url" | "port" | "expireSessions" | "sessions" | "stop" | "restart"> = {
    auths: [],
    seen: [],
    methods: [],
    cancelled: [],
    slowAborted: 0,
    paths: [],
    verbs: [],
    refuse: new Set(),
    forbid: new Set(),
    httpAborts: 0,
    deleteAborts: 0,
    executed: {},
  };
  let inits = 0;
  const allTools: unknown[] = [
    ...TOOLS,
    ...Array.from({ length: opts.extraTools ?? 0 }, (_, i) => ({
      name: `gen_${i}`,
      description: `generated tool ${i} `.padEnd(200, "."),
      inputSchema: { type: "object", properties: {} },
    })),
  ];

  function newServer(): Server {
    const server = new Server({ name: "example-upstream", version: "9.9.9" }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
    server.setRequestHandler(ListToolsRequestSchema, async (req) => {
      const size = opts.pageSize ?? allTools.length;
      const start = Number(req.params?.cursor ?? 0);
      const next = start + size;
      return {
        tools: allTools.slice(start, next) as never[],
        ...(next < allTools.length ? { nextCursor: String(next) } : {}),
      };
    });
    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      switch (req.params.name) {
        case "echo":
          return { content: [{ type: "text", text: String(args.text) }] };
        case "nested":
          return { content: [{ type: "text", text: JSON.stringify(args) }] };
        case "structured": {
          const doubled = Number(args.n ?? 0) * 2;
          return { content: [{ type: "text", text: JSON.stringify({ doubled }) }], structuredContent: { doubled } };
        }
        case "image":
          return { content: [{ type: "image", data: PNG_1PX, mimeType: "image/png" }, { type: "text", text: "a pixel" }] };
        case "fail":
          return { content: [{ type: "text", text: "the example service said no" }], isError: true };
        case "big":
          return { content: [{ type: "text", text: "x".repeat(Number(args.n ?? 0)) }] };
        case "slow":
          await new Promise<void>((resolve) => {
            if (extra.signal.aborted) return resolve();
            extra.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          state.slowAborted++;
          return { content: [{ type: "text", text: "too late" }] };
        case "whoami":
          return { content: [{ type: "text", text: (extra.requestInfo?.headers?.authorization as string | undefined) ?? "(none)" }] };
        default:
          throw new Error(`no tool named ${req.params.name}`);
      }
    });
    return server;
  }

  const http = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const u = new URL(req.url);
      state.paths.push(u.pathname);
      state.verbs.push(req.method);
      if (opts.redirectTo && u.pathname === "/mcp") {
        return new Response(null, { status: 307, headers: { location: opts.redirectTo } });
      }
      const auth = req.headers.get("authorization");
      state.auths.push(auth);
      state.seen.push({ auth, apiKey: req.headers.get("x-api-key"), search: u.search });
      const bearer = auth?.replace(/^Bearer /, "");
      if (bearer && state.refuse.has(bearer)) return new Response(LEAKY_BODY, { status: 401 });
      if (bearer && state.forbid.has(bearer)) return new Response(LEAKY_BODY, { status: 403 });

      if (req.method === "POST") {
        const body = await req.clone().json().catch(() => null);
        for (const m of Array.isArray(body) ? body : [body]) {
          if (m?.method) state.methods.push(m.method);
          if (m?.method === "initialize" && opts.onInitialize) {
            const answer = await opts.onInitialize(++inits);
            if (answer) return answer;
          }
          if (m?.method === "notifications/cancelled") state.cancelled.push(m.params?.requestId);
          // A `slow` call never completes on its own: an abort of its HTTP
          // request means the client dropped the connection.
          if (m?.method === "tools/call" && m.params?.name === "slow") {
            req.signal.addEventListener("abort", () => void state.httpAborts++, { once: true });
          }
          // Faults AFTER the tool ran: the client cannot know whether it did.
          if (m?.method === "tools/call" && (m.params?.name === "fault_502" || m.params?.name === "fault_drop")) {
            const name = m.params.name as string;
            state.executed[name] = (state.executed[name] ?? 0) + 1;
            if (name === "fault_502") return new Response("bad gateway", { status: 502 });
            const broken = new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":'));
                c.error(new Error("connection lost"));
              },
            });
            return new Response(broken, { headers: { "content-type": "application/json" } });
          }
          // Event-stream faults after the tool ran: the stream breaks off (with or
          // without a priming event id), or ends with no response at all.
          if (m?.method === "tools/call" && ["sse_drop", "sse_primed_drop", "sse_close"].includes(m.params?.name)) {
            const name = m.params.name as string;
            state.executed[name] = (state.executed[name] ?? 0) + 1;
            const enc = new TextEncoder();
            const stream = new ReadableStream({
              start(c) {
                if (name === "sse_primed_drop") c.enqueue(enc.encode("id: prime-1\ndata: \n\n"));
                if (name === "sse_close") return c.close();
                setTimeout(() => c.error(new Error("connection lost")), 10);
              },
            });
            return new Response(stream, { headers: { "content-type": "text/event-stream" } });
          }
        }
      }
      if (req.method === "DELETE" && opts.hangDelete) {
        req.signal.addEventListener("abort", () => void state.deleteAborts++, { once: true });
        return new Promise<Response>(() => {});
      }
      const sid = req.headers.get("mcp-session-id");
      if (sid) {
        const t = transports.get(sid);
        if (!t) return Response.json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }, { status: opts.unknownSessionStatus ?? 404 });
        return t.handleRequest(req);
      }
      const t = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: !!opts.json,
        onsessioninitialized: (id) => void transports.set(id, t),
        onsessionclosed: (id) => void transports.delete(id),
      });
      await newServer().connect(t);
      return t.handleRequest(req);
    },
  });
  return {
    ...state,
    get slowAborted() {
      return state.slowAborted;
    },
    get httpAborts() {
      return state.httpAborts;
    },
    get deleteAborts() {
      return state.deleteAborts;
    },
    url: `http://127.0.0.1:${http.port}/mcp`,
    port: http.port!,
    expireSessions: () => transports.clear(),
    restart: () => transports.clear(),
    sessions: () => transports.size,
    stop: () => http.stop(true),
  } as Upstream;
}
