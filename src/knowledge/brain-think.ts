import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { join } from "node:path";
import { getBrain } from "./brain";
import type { BrainScope } from "./scope";

/**
 * kb_think synthesis routed through the claude-agent-sdk instead of gbrain's
 * raw Anthropic client. Why: the SDK honors slaude's existing auth
 * (CLAUDE_CODE_OAUTH_TOKEN subscription or ANTHROPIC_* gateway env) — putting
 * a bare ANTHROPIC_API_KEY in the pod env just for gbrain would also flip the
 * main agent loop's billing (explicit key beats subscription). One auth path,
 * decided once, reused here.
 */

type AnthropicishParams = {
  model?: string;
  max_tokens?: number;
  system?: unknown;
  messages: Array<{ role: string; content: unknown }>;
};

export type ThinkClient = {
  create(params: AnthropicishParams, opts?: { signal?: AbortSignal }): Promise<unknown>;
};

const blocksToText = (c: unknown): string =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : "")).join("")
      : "";

export function sdkThinkClient(runner: typeof sdkQuery = sdkQuery): ThinkClient {
  return {
    async create(params) {
      const system = blocksToText(params.system) || undefined;
      const userText = params.messages.map((m) => blocksToText(m.content)).join("\n\n");
      let text = "";
      const it = runner({
        prompt: (async function* () {
          yield { type: "user" as const, message: { role: "user" as const, content: userText }, parent_tool_use_id: null };
        })() as never,
        options: {
          systemPrompt: system,
          // Pure synthesis: no tools, no side effects, one turn. gbrain's
          // resolved model id is ignored on purpose — the SDK session default
          // (subscription / gateway env) is the one auth+model decision.
          allowedTools: [],
          permissionMode: "bypassPermissions" as const,
          maxTurns: 1,
        },
      });
      for await (const msg of it as AsyncIterable<{ type: string; message?: { content?: Array<{ type: string; text?: string }> } }>) {
        if (msg.type === "assistant") {
          for (const b of msg.message?.content ?? []) if (b.type === "text") text += b.text ?? "";
        }
      }
      return {
        id: "sdk-think",
        type: "message",
        role: "assistant",
        model: "sdk-session-default",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    },
  };
}

/**
 * Scoped think: gbrain's gather (pages + takes + graph + trajectory) with the
 * caller's source scope, synthesized through the SDK client above.
 * runThink isn't in gbrain's package exports — imported by file path.
 */
export async function brainThink(
  question: string,
  scope: BrainScope,
  deps: { client?: ThinkClient } = {},
): Promise<unknown> {
  const engine = await getBrain();
  const thinkPath = join(import.meta.dir, "../../node_modules/gbrain/src/core/think/index.ts");
  const { runThink } = (await import(thinkPath)) as {
    runThink: (e: unknown, o: Record<string, unknown>) => Promise<unknown>;
  };
  return runThink(engine, {
    question,
    remote: true,
    sourceId: scope.sourceId,
    allowedSources: scope.allowedSources,
    takesHoldersAllowList: [scope.clientId, "world"],
    client: deps.client ?? sdkThinkClient(),
  });
}
