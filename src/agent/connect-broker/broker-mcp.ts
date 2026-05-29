import { z } from "zod";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { CallOutcome } from "./broker-core";

export const CONNECT_MCP_NAME = "slaude_connect";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

export type BrokerToolCtx = {
  /** The slack user id whose turn is currently executing (in-band, B1). */
  callerUserId: string;
  runCall: (input: { caller: string; service: string; tool: string; args: unknown }) => Promise<CallOutcome>;
  listConnections: () => Array<{ service: string; owner: string; mine: boolean; expiresInMs: number | null }>;
  startConnect: (service: string) => Promise<{ url: string; expiresInMs: number }>;
  revoke: (service?: string) => { revoked: number };
  describe: (service: string) => Promise<unknown>;
};

export const brokerHandlers = {
  async mcp_call(ctx: BrokerToolCtx, input: { service: string; tool: string; args?: unknown; on_behalf_of: string }): Promise<ToolResult> {
    // B1: the agent must pass the identity of the user it is acting for. We
    // validate it equals the turn's caller; we never read mutable session ctx.
    if (input.on_behalf_of !== ctx.callerUserId) {
      return err(`on_behalf_of (${input.on_behalf_of}) must equal the requesting user (${ctx.callerUserId}). Pass the user id of the person whose message you are answering.`);
    }
    const r = await ctx.runCall({ caller: ctx.callerUserId, service: input.service, tool: input.tool, args: input.args ?? {} });
    switch (r.kind) {
      case "ok": return ok(JSON.stringify(r.result, null, 2));
      case "needs_connect": return ok(`No \`${input.service}\` connection available. Call \`connect("${input.service}")\` to set one up, then retry.`);
      case "denied": return err(r.reason);
    }
  },

  async connections_list(ctx: BrokerToolCtx, _input: Record<string, never>): Promise<ToolResult> {
    const list = ctx.listConnections();
    if (!list.length) return ok("No connections in this thread.");
    const lines = list.map((c) => {
      const who = c.mine ? "yours" : `@${c.owner}`;
      const ttl = c.expiresInMs == null ? "no expiry" : `expires in ${Math.round(c.expiresInMs / 60000)}m`;
      return `• ${c.service} — ${who} — ${ttl}`;
    });
    return ok(lines.join("\n"));
  },

  async connect(ctx: BrokerToolCtx, input: { service: string }): Promise<ToolResult> {
    const { url, expiresInMs } = await ctx.startConnect(input.service);
    return ok(`Open this secure login link (expires in ${Math.round(expiresInMs / 60000)}m, only you can use it): ${url}`);
  },

  async connections_revoke(ctx: BrokerToolCtx, input: { service?: string }): Promise<ToolResult> {
    const { revoked } = ctx.revoke(input.service);
    return ok(`Revoked ${revoked} connection(s)/grant(s).`);
  },

  async mcp_describe(ctx: BrokerToolCtx, input: { service: string }): Promise<ToolResult> {
    return ok(JSON.stringify(await ctx.describe(input.service), null, 2));
  },
};

export function createConnectMcp(ctx: BrokerToolCtx): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: CONNECT_MCP_NAME,
    version: "0.1.0",
    tools: [
      tool(
        "mcp_call",
        "Invoke a tool on a per-user service connection (e.g. Jira). ALWAYS pass on_behalf_of = the slack user id of the person whose message you are answering. If it returns a connect hint, relay it; do not retry until they connect.",
        {
          service: z.string().describe("Service id, e.g. 'jira'."),
          tool: z.string().describe("Vendor tool name, e.g. 'jira_search'. Use mcp_describe to discover."),
          args: z.record(z.any()).optional().describe("Arguments object for the vendor tool."),
          on_behalf_of: z.string().describe("Slack user id of the person whose message you are answering."),
        },
        (input: any) => brokerHandlers.mcp_call(ctx, input),
      ),
      tool(
        "connections_list",
        "List service connections visible in this thread (yours + thread members'), with expiry.",
        {},
        (input: any) => brokerHandlers.connections_list(ctx, input),
      ),
      tool(
        "connect",
        "Start an interactive login to connect a service for the current user. Returns a one-time secure login URL to post back.",
        { service: z.string().describe("Service id to connect, e.g. 'jira'.") },
        (input: any) => brokerHandlers.connect(ctx, input),
      ),
      tool(
        "connections_revoke",
        "Revoke the caller's own connection(s) and any borrow grants. Omit service to revoke all.",
        { service: z.string().optional().describe("Service id to revoke; omit for all.") },
        (input: any) => brokerHandlers.connections_revoke(ctx, input),
      ),
      tool(
        "mcp_describe",
        "Return the available tool schemas for a connected service so you can build a correct mcp_call.",
        { service: z.string().describe("Service id to describe, e.g. 'jira'.") },
        (input: any) => brokerHandlers.mcp_describe(ctx, input),
      ),
    ],
  });
}
