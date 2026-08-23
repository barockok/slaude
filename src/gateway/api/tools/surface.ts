/**
 * POST /v1/tools/surface/<tool> — executes the same handler logic as the
 * `slaude_surface` MCP server by building the tool defs from the same
 * surfaceTools() factory over a Surface derived from the job claims. The
 * mounted def's schema IS the contract schema (imported by surface-mcp), so
 * validating against it here applies the identical shape the MCP side
 * registers; strict mode matches the REST-plane validation policy.
 */
import { z } from "zod";
import { surfaceTools } from "../../core/surface-mcp";
import type { JobClaims } from "../auth";
import type { ToolPlaneDeps, ToolResult } from "./deps";

export async function executeSurfaceTool(
  tool: string,
  body: unknown,
  claims: JobClaims,
  deps: ToolPlaneDeps,
): Promise<ToolResult | null> {
  const ctx = deps.slackCtx(claims);
  const surface = deps.surfaceFor(ctx);
  const defs = surfaceTools(surface, deps.surfaceOpts(claims, ctx));
  const def = defs.find((d) => d.name === tool);
  if (!def) return null; // in contract but not mounted for this surface's capabilities
  const args = z.object(def.schema).strict().parse(body ?? {});
  return def.handler(args);
}
