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
  /**
   * REST-plane-only tool: exposed on `POST /v1/tools/...` for node runtime
   * plumbing (e.g. runtime/can_use_tool) but NEVER mounted as an MCP tool —
   * the model must not see it. MCP builders, node shims and the contract
   * snapshot tests all skip restOnly entries.
   */
  restOnly?: boolean;
}

/** The subset of a server's tools that MCP servers (and node shims) mount. */
export function mcpMountedTools(contract: ServerContract): ToolContract[] {
  return Object.values(contract.tools).filter((t) => !t.restOnly);
}

export interface ServerContract {
  /** MCP server name, e.g. "slaude_surface". */
  server: string;
  /** Every tool the server can mount, keyed by tool name. */
  tools: Record<string, ToolContract>;
}

/** Infer the parsed input type of a contract's schema. */
export type InputOf<T extends ToolContract> = z.infer<z.ZodObject<T["schema"]>>;

/**
 * Validate an unknown request body against a tool contract and return the
 * schema-inferred args. Strict: unknown top-level keys are rejected (one
 * validation policy across the REST plane — same as the session PATCH schema).
 * Throws ZodError on invalid input; the /v1 router maps that to a 400.
 *
 * The generic keeps the inferred type precise, so call sites pass the result
 * STRAIGHT into the same handlers the MCP builders use — tsc then checks the
 * contract schema against each handler's parameter type, exactly like the SDK
 * `tool()` helper does on the MCP side. No casts.
 */
export function parseToolArgs<S extends ZodShape>(t: ToolContract<S>, body: unknown): z.infer<z.ZodObject<S>> {
  return z.object(t.schema).strict().parse(body ?? {});
}

/** Render a ZodError's issues as one compact line for a 400 body. */
export function zodIssueLine(e: z.ZodError): string {
  return e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}
