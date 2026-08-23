/**
 * POST /v1/tools/slack/<tool> — same handlers as the `slaude_slack` MCP server
 * (slackHandlers), context derived from the job claims. Each case parses the
 * body with the tool's contract schema and passes the inferred args straight
 * into the handler, so tsc checks contract-vs-handler drift exactly like the
 * SDK `tool()` helper does on the MCP side.
 */
import { slackHandlers } from "../../slack/mcp-tools";
import { slackContract } from "../../../tools/contracts/slack";
import { parseToolArgs } from "../../../tools/contracts/types";
import type { JobClaims } from "../auth";
import type { ToolPlaneDeps, ToolResult } from "./deps";

const c = slackContract.tools;

export async function executeSlackTool(
  tool: string,
  body: unknown,
  claims: JobClaims,
  deps: ToolPlaneDeps,
): Promise<ToolResult | null> {
  const ctx = deps.slackCtx(claims);
  switch (tool) {
    case c.reply.name:
      return slackHandlers.reply(ctx, parseToolArgs(c.reply, body));
    case c.get_user_profile.name:
      return slackHandlers.get_user_profile(ctx, parseToolArgs(c.get_user_profile, body));
    case c.get_channel_info.name:
      parseToolArgs(c.get_channel_info, body);
      return slackHandlers.get_channel_info(ctx);
    case c.list_users_in_channel.name:
      return slackHandlers.list_users_in_channel(ctx, parseToolArgs(c.list_users_in_channel, body));
    case c.search_messages.name:
      return slackHandlers.search_messages(ctx, parseToolArgs(c.search_messages, body));
    default:
      return null;
  }
}
