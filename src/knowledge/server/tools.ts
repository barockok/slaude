// The dumb-engine MCP tool surface for the brain server. Exactly two tools that
// carry an already-resolved scope (from slaude) to the local engine primitives.
// No scope resolution, no gating here — that stays in slaude. OAuth is the trust
// boundary: anything reaching these handlers is an authenticated slaude.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrainScope } from "../scope";

export interface BrainServerDeps {
  runScoped(name: string, params: Record<string, unknown>, scope: BrainScope): Promise<unknown>;
  runAdmin(name: string, params: Record<string, unknown>, sourceId: string): Promise<unknown>;
}

function jsonContent(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result ?? null) }] };
}

function errContent(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }] };
}

export function registerBrainTools(server: McpServer, deps: BrainServerDeps): void {
  server.tool(
    "brain_op",
    "Run a scoped gbrain engine op. Scope is resolved by the caller (slaude).",
    {
      op: z.string(),
      params: z.record(z.unknown()).default({}),
      clientId: z.string(),
      sourceId: z.string(),
      allowedSources: z.array(z.string()),
    },
    async (args) => {
      try {
        const scope: BrainScope = {
          clientId: args.clientId,
          sourceId: args.sourceId,
          allowedSources: args.allowedSources,
        };
        const result = await deps.runScoped(args.op, args.params ?? {}, scope);
        return jsonContent(result);
      } catch (e) {
        return errContent(e);
      }
    },
  );

  server.tool(
    "brain_admin_op",
    "Run a trusted gbrain admin op (sources, sync). Reachable only behind OAuth.",
    {
      op: z.string(),
      params: z.record(z.unknown()).default({}),
      sourceId: z.string().default("default"),
    },
    async (args) => {
      try {
        const result = await deps.runAdmin(args.op, args.params ?? {}, args.sourceId ?? "default");
        return jsonContent(result);
      } catch (e) {
        return errContent(e);
      }
    },
  );
}
