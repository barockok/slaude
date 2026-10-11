/**
 * POST /v1/tools/mcpx/<server>/list|call — the MCP bridge's tool-plane routes
 * (WS-C §4.2.3). A node relays its in-process server's `tools/list` and
 * `tools/call` here; the gateway is the MCP client to the persona's real
 * server (src/gateway/core/mcp-bridge.ts).
 *
 * Context comes ONLY from the verified job claims (tenant, persona, session,
 * thread, runAs): the body carries the tool name and arguments and nothing
 * else the gateway acts on. A server the claims' persona does not mount is a
 * 404 with the same text as one that does not exist.
 *
 *   list  → 200 {tools, instructions?, serverInfo?} as the upstream answered,
 *           or {tools: [], instructions: <fixed reason>, unavailable: true}
 *   call  → 200 the upstream's CallToolResult, or an isError result with fixed
 *           text: a failing upstream is a tool error, never a failed request
 */
import type { JobClaims } from "../auth";
import { json, notFound } from "../http";
import { m as metric } from "../../../metrics";
import { BridgeRefused, NOT_MOUNTED } from "../../core/mcp-bridge";
import type { ToolPlaneDeps } from "./deps";

const MAX_TOOL_NAME = 256;

export async function handleMcpx(
  req: Request,
  rawServer: string,
  op: "list" | "call",
  claims: JobClaims,
  deps: Pick<ToolPlaneDeps, "mcpBridge">,
): Promise<Response> {
  const bridge = deps.mcpBridge;
  if (!bridge) return notFound(NOT_MOUNTED);
  let server: string;
  try {
    server = decodeURIComponent(rawServer);
  } catch {
    return notFound(NOT_MOUNTED);
  }

  const max = bridge.limits().maxRequestBytes;
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return json(413, { error: `request body is over ${max} bytes` });
  const text = await req.text();
  if (Buffer.byteLength(text) > max) return json(413, { error: `request body is over ${max} bytes` });
  let body: unknown = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      return json(400, { error: "malformed JSON body" });
    }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, { error: "body must be a JSON object" });

  metric.v1ToolCallsTotal.inc({ server: "mcpx", tool: op });
  try {
    if (op === "list") return json(200, await bridge.list(claims, server, req.signal));
    const { name, arguments: args } = body as { name?: unknown; arguments?: unknown };
    if (typeof name !== "string" || !name || name.length > MAX_TOOL_NAME) {
      return json(400, { error: "name must be a non-empty tool name" });
    }
    if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) {
      return json(400, { error: "arguments must be an object" });
    }
    return json(200, await bridge.call(claims, server, name, args ?? {}, req.signal));
  } catch (e) {
    if (e instanceof BridgeRefused) return json(e.status, { error: e.message });
    throw e;
  }
}
