import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import type { UsageSnapshot } from "./token-budget";

export const SESSION_MCP_NAME = "slaude_session";

export type SessionContext = {
  getSnapshot: () => UsageSnapshot | null;
};

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};
export const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

export const sessionHandlers = {
  async token_budget(ctx: SessionContext): Promise<ToolResult> {
    const s = ctx.getSnapshot();
    if (!s) return ok("no usage recorded yet — call again after the next turn");
    const payload = {
      input_tokens: s.inputTokens,
      output_tokens: s.outputTokens,
      cache_read_input_tokens: s.cacheReadInputTokens,
      cache_creation_input_tokens: s.cacheCreationInputTokens,
      total_input: s.totalInput,
      context_window: s.contextWindow,
      remaining: s.remaining,
      pct_used: s.pctUsed,
      percent_used_human: `${(s.pctUsed * 100).toFixed(1)}%`,
    };
    return ok(JSON.stringify(payload, null, 2));
  },
};

export function createSessionMcp(
  ctx: SessionContext,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: SESSION_MCP_NAME,
    version: "0.1.0",
    tools: [
      tool(
        "token_budget",
        "Return current session's context-window usage: input/output/cache token counts, total prompt size last turn, context window cap, percent used, and remaining headroom. Call when deciding whether to summarize-and-reset, drop earlier context, or warn the user that the conversation is about to be auto-compacted.",
        {},
        () => sessionHandlers.token_budget(ctx),
      ),
    ],
  });
}
