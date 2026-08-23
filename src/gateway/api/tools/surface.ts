/**
 * POST /v1/tools/surface/<tool> — executes the same handler logic as the
 * `slaude_surface` MCP server by building the tool defs from the same
 * surfaceTools() factory over a Surface derived from the job claims.
 */
import { surfaceTools } from "../../core/surface-mcp";
import type { JobClaims } from "../auth";
import type { ToolPlaneDeps, ToolResult } from "./deps";

export async function executeSurfaceTool(
  tool: string,
  args: Record<string, unknown>,
  claims: JobClaims,
  deps: ToolPlaneDeps,
): Promise<ToolResult | null> {
  const ctx = deps.slackCtx(claims);
  const surface = deps.surfaceFor(ctx);
  const defs = surfaceTools(surface, deps.surfaceOpts(claims, ctx));
  const def = defs.find((d) => d.name === tool);
  if (!def) return null; // in contract but not mounted for this surface's capabilities
  return def.handler(args);
}
