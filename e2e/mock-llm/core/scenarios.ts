import { paramInt } from "./tag";
import type { Scenario } from "./types";

/** slaude's surface reply tool: plain assistant text never reaches the user there. */
export const SURFACE_REPLY_TOOL = "mcp__slaude_surface__reply";

const echo: Scenario = {
  name: "echo",
  reply: ({ view, userText }) => {
    const content = `[${view.persona ?? "unknown"}] ${userText}`;
    if (!view.tools.includes(SURFACE_REPLY_TOOL)) return { kind: "text", content };
    if (view.toolResults.length > 0) return { kind: "text", content: "replied" };
    return { kind: "tools", calls: [{ id: "toolu_mock_reply", name: SURFACE_REPLY_TOOL, args: { text: content } }] };
  },
};

/**
 * A tool call's arguments: `args=<base64url JSON object>` when the tag gives
 * them (a tag value cannot hold spaces), else `{ command: "echo step-<n>" }`.
 * Malformed args fall back to the default, so a typo is a visible tool error.
 */
function toolArgs(raw: string | undefined, step: number): Record<string, unknown> {
  if (raw) {
    try {
      const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  return { command: `echo step-${step}` };
}

const multiTool: Scenario = {
  name: "multi-tool",
  reply: ({ tag, view }) => {
    const n = paramInt(tag, "n", 2);
    const done = view.toolResults.length;
    if (done >= n) return { kind: "text", content: `done after ${n} tools` };
    // `id=<word>` makes this turn's call ids its own. A session that is RESUMED from its transcript drops a tool call
    // whose id an earlier turn already used (the CLI reads it as a duplicate), so a second multi-tool turn of a resumed
    // thread never sees its results and loops. Ids stay a pure function of the request either way.
    const own = /^[a-z0-9-]{1,24}$/.test(tag.params["id"] ?? "") ? `${tag.params["id"]}_` : "";
    return {
      kind: "tools",
      calls: [{ id: `toolu_mock_${own}${done + 1}`, name: tag.params["tool"] ?? "Bash", args: toolArgs(tag.params["args"], done + 1) }],
    };
  },
};

const longStream: Scenario = {
  name: "long-stream",
  reply: ({ tag }) => {
    const chunks = paramInt(tag, "chunks", 20);
    return { kind: "text", content: Array.from({ length: chunks }, (_, i) => `chunk-${i} `).join("").trimEnd() };
  },
};

const think: Scenario = {
  name: "think",
  reply: () => ({
    kind: "text",
    content: "thought about it",
    reasoning: "private reasoning that must never reach Slack",
  }),
};

export const SCENARIOS: Map<string, Scenario> = new Map([echo, multiTool, longStream, think].map((s) => [s.name, s]));
