/**
 * POST /v1/tools/connect/<tool> — the `slaude_connect` front door, routed into
 * the gateway's connect engine (same scope gates as the MCP tool). Args are
 * contract-parsed, so tsc checks them against the engine signature.
 */
import { connectContract } from "../../../tools/contracts/connect";
import { parseToolArgs } from "../../../tools/contracts/types";
import type { JobClaims } from "../auth";
import type { ToolPlaneDeps, ToolResult } from "./deps";

const c = connectContract.tools;

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

export async function executeConnectTool(
  tool: string,
  body: unknown,
  claims: JobClaims,
  deps: ToolPlaneDeps,
): Promise<ToolResult | null> {
  if (tool !== c.connect_mcp.name) return null;
  const a = parseToolArgs(c.connect_mcp, body);
  const ctx = deps.slackCtx(claims);
  return ok(await deps.connect(claims, ctx, a.server));
}
