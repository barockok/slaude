/**
 * POST /v1/tools/slack/<tool> — same handlers as the `slaude_slack` MCP server
 * (slackHandlers), context derived from the job claims.
 */
import { slackHandlers } from "../../slack/mcp-tools";
import type { JobClaims } from "../auth";
import type { ToolPlaneDeps, ToolResult } from "./deps";

export async function executeSlackTool(
  tool: string,
  args: Record<string, unknown>,
  claims: JobClaims,
  deps: ToolPlaneDeps,
): Promise<ToolResult | null> {
  const ctx = deps.slackCtx(claims);
  switch (tool) {
    case "reply":
      return slackHandlers.reply(ctx, args as { text: string });
    case "get_user_profile":
      return slackHandlers.get_user_profile(ctx, args as { user_id?: string });
    case "get_channel_info":
      return slackHandlers.get_channel_info(ctx);
    case "list_users_in_channel":
      return slackHandlers.list_users_in_channel(ctx, args as { limit?: number });
    case "search_messages":
      return slackHandlers.search_messages(ctx, args as { query: string; count?: number });
    default:
      return null;
  }
}
