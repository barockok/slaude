// The dumb-engine MCP tool surface for the brain server. Exactly two tools that
// carry an already-resolved scope (from slaude) to the local engine primitives.
// No scope resolution, no gating here — that stays in slaude. OAuth is the trust
// boundary: anything reaching these handlers is an authenticated slaude.

import { z, type ZodRawShape } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrainScope } from "../scope";

export interface BrainServerDeps {
  runScoped(name: string, params: Record<string, unknown>, scope: BrainScope): Promise<unknown>;
  runAdmin(name: string, params: Record<string, unknown>, sourceId: string): Promise<unknown>;
}

interface BrainOpArgs {
  op: string;
  params?: Record<string, unknown>;
  clientId: string;
  sourceId: string;
  allowedSources: string[];
}

interface BrainAdminOpArgs {
  op: string;
  params?: Record<string, unknown>;
  sourceId?: string;
}

// Shapes are annotated `ZodRawShape` (not their precise literal types) so the MCP
// SDK's `tool()` overload infers a shallow arg type instead of a deep mapped type
// — the literal shapes otherwise trip TS2589 ("excessively deep"). Runtime zod
// validation is identical; handler args are re-typed explicitly below.
const brainOpShape: ZodRawShape = {
  op: z.string(),
  params: z.record(z.unknown()).default({}),
  clientId: z.string(),
  sourceId: z.string(),
  allowedSources: z.array(z.string()),
};

const brainAdminOpShape: ZodRawShape = {
  op: z.string(),
  params: z.record(z.unknown()).default({}),
  sourceId: z.string().default("default"),
};

function jsonContent(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result ?? null) }] };
}

function errContent(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }] };
}

// Loosely-typed view over `server.tool` that pins the (name, description, shape,
// handler) overload non-generically. The SDK's generic `tool()` instantiates a
// deep mapped type from the literal shape (TS2589); binding to this signature
// detaches that inference. Runtime is the bound `server.tool` — unchanged.
type ToolRegistrar = (
  name: string,
  description: string,
  shape: ZodRawShape,
  handler: (args: Record<string, unknown>) => Promise<unknown>,
) => void;

export function registerBrainTools(server: McpServer, deps: BrainServerDeps): void {
  const tool = server.tool.bind(server) as unknown as ToolRegistrar;

  tool(
    "brain_op",
    "Run a scoped gbrain engine op. Scope is resolved by the caller (slaude).",
    brainOpShape,
    async (raw) => {
      const args = raw as unknown as BrainOpArgs;
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

  tool(
    "brain_admin_op",
    "Run a trusted gbrain admin op (sources, sync). Reachable only behind OAuth.",
    brainAdminOpShape,
    async (raw) => {
      const args = raw as unknown as BrainAdminOpArgs;
      try {
        const result = await deps.runAdmin(args.op, args.params ?? {}, args.sourceId ?? "default");
        return jsonContent(result);
      } catch (e) {
        return errContent(e);
      }
    },
  );
}
