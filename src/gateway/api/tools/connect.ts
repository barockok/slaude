/**
 * POST /v1/tools/connect/<tool> — the `slaude_connect` front door, routed into
 * the gateway's connect engine (same scope gates as the MCP tool).
 */
import type { JobClaims } from "../auth";
import type { ToolPlaneDeps, ToolResult } from "./deps";

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

export async function executeConnectTool(
  tool: string,
  args: Record<string, unknown>,
  claims: JobClaims,
  deps: ToolPlaneDeps,
): Promise<ToolResult | null> {
  if (tool !== "connect_mcp") return null;
  const ctx = deps.slackCtx(claims);
  return ok(await deps.connect(claims, ctx, (args as { server: string }).server));
}
