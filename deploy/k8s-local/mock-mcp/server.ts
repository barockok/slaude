// A throwaway OAuth-protected HTTP MCP server for the local cluster. Two jobs:
//
//   - the portal's connect flow: it is the resource server and the
//     authorization server in one (protected-resource metadata,
//     authorization-server metadata, dynamic client registration, an authorize
//     endpoint that approves instantly, a token endpoint);
//   - the MCP bridge's upstream: /mcp speaks just enough MCP over streamable
//     HTTP (initialize, tools/list, tools/call, ping) for the gateway's client,
//     with one tool, `echo`.
//
// Any bearer is accepted, until POST /control/revoke makes every bearer fail
// with 401 (POST /control/restore undoes it), so the runbook can show what an
// upstream revocation looks like. Nothing is validated: this is a test double,
// never deploy it outside a local cluster.
const PORT = Number(process.env.MOCK_MCP_PORT ?? 9000);
const ORIGIN = process.env.MOCK_MCP_ORIGIN ?? `http://localhost:${PORT}`;
const PROTOCOL_VERSION = "2025-03-26";
let revoked = false;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

type RpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };

const ECHO_TOOL = {
  name: "echo",
  description: "Returns the text it is given, prefixed with 'echo: '. A local test tool.",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};

/** One JSON-RPC message: a response object, or null for a notification. */
function handle(msg: RpcRequest): unknown | null {
  const isNotification = msg.id === undefined || msg.id === null;
  const result = (r: unknown) => ({ jsonrpc: "2.0", id: msg.id, result: r });
  const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  if (isNotification) return null;
  switch (msg.method) {
    case "initialize":
      return result({
        protocolVersion: msg.params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "slaude-local-mock-mcp", version: "1.0.0" },
        instructions: "A local test server. Its one tool, echo, returns what it is given.",
      });
    case "ping":
      return result({});
    case "tools/list":
      return result({ tools: [ECHO_TOOL] });
    case "tools/call": {
      if (msg.params?.name !== "echo") return error(-32602, `unknown tool: ${String(msg.params?.name ?? "")}`);
      const text = String(msg.params?.arguments?.text ?? "");
      return result({ content: [{ type: "text", text: `echo: ${text}` }], isError: false });
    }
    default:
      return error(-32601, `method not found: ${String(msg.method ?? "")}`);
  }
}

async function mcp(req: Request): Promise<Response> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ") || revoked) {
    return new Response("unauthorized", {
      status: 401,
      headers: { "www-authenticate": `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"` },
    });
  }
  // No server-to-client stream, and nothing to end.
  if (req.method === "GET") return new Response("method not allowed", { status: 405 });
  if (req.method === "DELETE") return new Response(null, { status: 200 });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
  }
  const msgs = Array.isArray(body) ? (body as RpcRequest[]) : [body as RpcRequest];
  const out = msgs.map(handle).filter((r) => r !== null);
  const headers: Record<string, string> = {};
  if (msgs.some((m) => m?.method === "initialize")) headers["mcp-session-id"] = crypto.randomUUID();
  if (out.length === 0) return new Response(null, { status: 202, headers });
  return json(Array.isArray(body) ? out : out[0], 200, headers);
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    console.log(req.method, url.pathname);
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname === "/control/revoke" && req.method === "POST") {
      revoked = true;
      return json({ revoked });
    }
    if (url.pathname === "/control/restore" && req.method === "POST") {
      revoked = false;
      return json({ revoked });
    }
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json({
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/authorize`,
        token_endpoint: `${ORIGIN}/token`,
        registration_endpoint: `${ORIGIN}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/register" && req.method === "POST") {
      const body: any = await req.json().catch(() => ({}));
      return json({ ...body, client_id: `mock-${crypto.randomUUID()}`, client_secret: crypto.randomUUID() }, 201);
    }
    if (url.pathname === "/authorize") {
      const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
      redirect.searchParams.set("code", "mock-code");
      const state = url.searchParams.get("state");
      if (state) redirect.searchParams.set("state", state);
      return Response.redirect(redirect.toString(), 302);
    }
    if (url.pathname === "/token" && req.method === "POST") {
      if (revoked) return json({ error: "invalid_grant" }, 400);
      return json({ access_token: `mock-at-${crypto.randomUUID()}`, refresh_token: `mock-rt-${crypto.randomUUID()}`, token_type: "Bearer", expires_in: 3600 });
    }
    if (url.pathname === "/mcp") return mcp(req);
    return new Response("not found", { status: 404 });
  },
});
console.log(`mock mcp listening on :${PORT}, origin`, ORIGIN);
