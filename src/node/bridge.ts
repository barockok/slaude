/**
 * The MCP bridge, node side (WS-C §4.2.2): one generic in-process MCP server
 * per bridged server name in the runtime bundle. Its two request handlers are
 * set on the low-level `.server` and do NO conversion — no zod, no reshaping:
 *
 *   tools/list → the list fetched ONCE, at child boot, from
 *                POST /v1/tools/mcpx/<server>/list
 *   tools/call → POST /v1/tools/mcpx/<server>/call {name, arguments}, the
 *                gateway's CallToolResult returned unchanged
 *
 * The agent sees `mcp__<server>__<tool>` with the upstream's own names,
 * descriptions and JSON Schemas, and the upstream's `instructions`. No URL,
 * header or credential is ever on the node: the gateway is the MCP client and
 * chooses the credential per call from the job token's runAs.
 *
 * Why the list is fixed at boot (measured, §4.2.5): the CLI lists tools once and
 * ignores list_changed, and reconnectMcpServer does not work on in-process
 * servers. So the list reflects the identity the child booted as; per-call
 * credentials still follow the CURRENT runAs, because the job token is read on
 * every call (a coalesced follow-up job's fresher token replaces an older one,
 * exactly as the shims do). A lock flip reboots the child, which re-lists.
 *
 * A gateway that refuses this node for this agent (GateDenied, label gate)
 * makes the call a tool error and marks the session (onGateDenied).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { GateDenied, NodeApiError, type NodeClient } from "./client";

export interface BridgeDeps {
  client: Pick<NodeClient, "postMcpx">;
  /** Live per-session job token (worker-maintained; newest job wins). */
  tokenFor(sessionId: string): string | undefined;
  /** The gateway's label gate refused this node for this session's agent. */
  onGateDenied?(sessionId: string): void;
  warn?(message: string): void;
}

const errResult = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

export const GATE_DENIED_TEXT = "the gateway refused this node for this agent; this tool cannot run here";

/** Why a call never reached a result, without any gateway body. */
function failureText(server: string, e: unknown): string {
  if (e instanceof NodeApiError) return `${server} is unreachable through the gateway (status ${e.status})`;
  if (e instanceof Error && e.name === "AbortError") return `the call to ${server} was cancelled`;
  return `${server} is unreachable through the gateway`;
}

interface Listed {
  tools: unknown[];
  instructions?: string;
  serverInfo?: { version?: unknown };
}

/** One server's generic relay, with the list it booted with. */
function relayServer(sessionId: string, server: string, listed: Listed, deps: BridgeDeps): McpServerConfig {
  const version = typeof listed.serverInfo?.version === "string" ? listed.serverInfo.version : "0.0.0";
  const mcp = new McpServer(
    { name: server, version },
    {
      capabilities: { tools: { listChanged: true } },
      ...(typeof listed.instructions === "string" && listed.instructions ? { instructions: listed.instructions } : {}),
    },
  );
  const tools = listed.tools;
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }) as never);
  mcp.server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const token = deps.tokenFor(sessionId);
    if (!token) return errResult(`no job token for session ${sessionId} — turn not started via the queue?`);
    try {
      return (await deps.client.postMcpx(
        server,
        "call",
        { name: req.params.name, arguments: req.params.arguments ?? {} },
        token,
        extra.signal,
      )) as never;
    } catch (e) {
      if (e instanceof GateDenied) {
        deps.onGateDenied?.(sessionId);
        return errResult(GATE_DENIED_TEXT);
      }
      return errResult(failureText(server, e));
    }
  });
  return { type: "sdk", name: server, instance: mcp };
}

/**
 * The bridged servers for a booting session. `names` comes from the runtime
 * bundle; a name in `reserved` (the node's own in-process servers) is skipped,
 * so a persona cannot shadow slaude's tools. A server whose list cannot be
 * fetched is left out of this session (logged); one the gateway reports
 * unavailable is mounted with no tools and the gateway's fixed reason as its
 * instructions, so the agent can say why.
 */
export async function buildBridgeServers(
  sessionId: string,
  names: readonly string[],
  deps: BridgeDeps,
  reserved: ReadonlySet<string> = new Set(),
): Promise<Record<string, McpServerConfig>> {
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const out: Record<string, McpServerConfig> = {};
  const token = deps.tokenFor(sessionId);
  if (!token || names.length === 0) return out;
  const listed = await Promise.all(
    names.map(async (server) => {
      if (reserved.has(server)) {
        warn(`[bridge] session=${sessionId} server '${server}' shadows a built-in server; not mounted`);
        return null;
      }
      try {
        const body = (await deps.client.postMcpx(server, "list", {}, token)) as unknown as Listed;
        if (!Array.isArray(body?.tools)) throw new Error("malformed list");
        return [server, body] as const;
      } catch (e) {
        if (e instanceof GateDenied) deps.onGateDenied?.(sessionId);
        warn(`[bridge] session=${sessionId} server '${server}' not mounted: ${failureText(server, e)}`);
        return null;
      }
    }),
  );
  for (const entry of listed) {
    if (entry) out[entry[0]] = relayServer(sessionId, entry[0], entry[1], deps);
  }
  return out;
}
