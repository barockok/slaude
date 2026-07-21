import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import type { UsageSnapshot } from "./token-budget";
import pkg from "../../package.json";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sdkVersion: string = (() => {
  try {
    const raw = readFileSync(resolve(import.meta.dir, "../../node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8");
    return (JSON.parse(raw) as any).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

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
  async version(): Promise<ToolResult> {
    return ok(JSON.stringify({ version: pkg.version, sdk_version: sdkVersion }, null, 2));
  },
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
        "version",
        "Return the running slaude version and the bundled claude-agent-sdk version (both semver, baked from package.json at build time). Use to answer questions about which version is deployed or to include in diagnostics.",
        {},
        () => sessionHandlers.version(),
      ),
      tool(
        "token_budget",
        "Return current session's context-window usage: input/output/cache token counts, total prompt size last turn, context window cap, percent used, and remaining headroom. Call when deciding whether to summarize-and-reset, drop earlier context, or warn the user that the conversation is about to be auto-compacted.",
        {},
        () => sessionHandlers.token_budget(ctx),
      ),
    ],
  });
}
