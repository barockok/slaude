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

const multiTool: Scenario = {
  name: "multi-tool",
  reply: ({ tag, view }) => {
    const n = paramInt(tag, "n", 2);
    const done = view.toolResults.length;
    if (done >= n) return { kind: "text", content: `done after ${n} tools` };
    return {
      kind: "tools",
      calls: [{ id: `toolu_mock_${done + 1}`, name: tag.params["tool"] ?? "Bash", args: { command: `echo step-${done + 1}` } }],
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
