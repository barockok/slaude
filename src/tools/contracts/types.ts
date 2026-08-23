/**
 * Shared tool contracts (spec §3 "Shared contracts").
 *
 * One module per MCP server exports the tool names, descriptions and zod input
 * schemas as the single source of truth. Three consumers import from here:
 *
 *   - the in-process MCP server builders (src/gateway/core/surface-mcp.ts,
 *     src/gateway/slack/mcp-tools.ts, src/skills/mcp-tools.ts,
 *     src/knowledge/mcp-tools.ts) — behavior unchanged, schemas now imported;
 *   - the gateway REST tool plane (`POST /v1/tools/<server>/<tool>`), which
 *     validates request bodies against the same schemas;
 *   - (M4) node-side shims that re-register the same tools over REST.
 *
 * Contracts list EVERY tool a server can mount; some mount conditionally
 * (surface capabilities, brain enablement). Keep this module dependency-free
 * beyond zod so node shims can import it without dragging in gateway code.
 */
import { z } from "zod";

export type ZodShape = Record<string, z.ZodTypeAny>;

export interface ToolContract<S extends ZodShape = ZodShape> {
  name: string;
  description: string;
  /** Zod raw shape — the exact object handed to the SDK `tool()` helper. */
  schema: S;
}

export interface ServerContract {
  /** MCP server name, e.g. "slaude_surface". */
  server: string;
  /** Every tool the server can mount, keyed by tool name. */
  tools: Record<string, ToolContract>;
}

/** Infer the parsed input type of a contract's schema. */
export type InputOf<T extends ToolContract> = z.infer<z.ZodObject<T["schema"]>>;

/** Look up a tool contract by name; throws on unknown tools (a programming error). */
export function contractTool(c: ServerContract, name: string): ToolContract {
  const t = c.tools[name];
  if (!t) throw new Error(`no contract for tool ${c.server}/${name}`);
  return t;
}

/** Validate an unknown body against a tool contract. */
export function parseToolInput(
  t: ToolContract,
  body: unknown,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const r = z.object(t.schema).safeParse(body ?? {});
  if (!r.success) {
    const issues = r.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: issues };
  }
  return { ok: true, args: r.data as Record<string, unknown> };
}
