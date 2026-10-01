import { describe, expect, test } from "bun:test";
import { resolveReply } from "./registry";
import type { MockRequest } from "./types";

const user = (text: string): MockRequest => ({ messages: [{ role: "user", content: text }] });

describe("resolveReply", () => {
  test("untagged requests get a valid text reply, never an error", () => {
    expect(resolveReply(user("write a title for this chat"))).toEqual({ kind: "text", content: "mock: untagged request" });
  });

  test("unknown scenario names are reported in the reply", () => {
    expect(resolveReply(user("[[mock:nope]] hi"))).toEqual({ kind: "text", content: "mock: unknown scenario nope" });
  });

  describe("echo", () => {
    test("echoes text with the persona and strips tags", () => {
      const req: MockRequest = {
        messages: [
          { role: "system", content: "Persona-ID: alpha" },
          { role: "user", content: "[[mock:echo]] hello there" },
        ],
      };
      expect(resolveReply(req)).toEqual({ kind: "text", content: "[alpha] hello there" });
    });

    test("never repeats a tag, so it cannot re-select a scenario next turn", () => {
      const reply = resolveReply(user("[[mock:echo]] again [[mock:think]]"));
      expect(reply.kind).toBe("text");
      expect((reply as { content: string }).content).not.toContain("[[mock:");
    });

    // slaude never shows plain assistant text: the agent speaks only through its surface reply
    // tool. When the request offers that tool, echo answers through it.
    const REPLY = "mcp__slaude_surface__reply";
    const offered = (extra: MockRequest["messages"] = []): MockRequest => ({
      messages: [{ role: "system", content: "Persona-ID: alpha" }, { role: "user", content: "[[mock:echo]] hello there" }, ...extra],
      tools: [{ type: "function", function: { name: "Bash" } }, { type: "function", function: { name: REPLY } }],
    });

    test("answers through the surface reply tool when the request offers it", () => {
      expect(resolveReply(offered())).toEqual({
        kind: "tools",
        calls: [{ id: "toolu_mock_reply", name: REPLY, args: { text: "[alpha] hello there" } }],
      });
    });

    test("ends the turn with a short text once the reply tool has returned", () => {
      const r = resolveReply(offered([{ role: "tool", tool_call_id: "toolu_mock_reply", content: "{\"ref\":\"1.2\"}" }]));
      expect(r).toEqual({ kind: "text", content: "replied" });
    });

    test("falls back to an unknown persona label", () => {
      expect(resolveReply(user("[[mock:echo]] hi"))).toEqual({ kind: "text", content: "[unknown] hi" });
    });
  });

  describe("multi-tool", () => {
    const withResults = (n: number, tag = "[[mock:multi-tool n=2]] go"): MockRequest => ({
      messages: [
        { role: "user", content: tag },
        ...Array.from({ length: n }, (_, i) => ({ role: "tool" as const, tool_call_id: `toolu_mock_${i + 1}`, content: `step-${i + 1}` })),
      ],
    });

    test("issues tool call 1 first, with a deterministic id", () => {
      expect(resolveReply(withResults(0))).toEqual({
        kind: "tools",
        calls: [{ id: "toolu_mock_1", name: "Bash", args: { command: "echo step-1" } }],
      });
    });

    test("issues tool call 2 after one result", () => {
      const r = resolveReply(withResults(1));
      expect(r.kind === "tools" && r.calls[0]!.id).toBe("toolu_mock_2");
    });

    test("summarises once all n results are in", () => {
      expect(resolveReply(withResults(2))).toEqual({ kind: "text", content: "done after 2 tools" });
    });

    test("defaults to two tools and accepts a tool name", () => {
      const r = resolveReply(withResults(0, "[[mock:multi-tool tool=Read]] go"));
      expect(r.kind === "tools" && r.calls[0]!.name).toBe("Read");
      expect(resolveReply(withResults(2, "[[mock:multi-tool]] go"))).toEqual({ kind: "text", content: "done after 2 tools" });
    });

    test("a second turn with its own tag starts again at phase zero", () => {
      const req: MockRequest = {
        messages: [
          { role: "user", content: "[[mock:multi-tool n=1]] one" },
          { role: "tool", tool_call_id: "toolu_mock_1", content: "step-1" },
          { role: "assistant", content: "done after 1 tools" },
          { role: "user", content: "[[mock:multi-tool n=1]] two" },
        ],
      };
      const r = resolveReply(req);
      expect(r.kind === "tools" && r.calls[0]!.id).toBe("toolu_mock_1");
    });
  });

  describe("long-stream", () => {
    test("produces the requested number of chunks", () => {
      const r = resolveReply(user("[[mock:long-stream chunks=5]] go"));
      expect(r.kind).toBe("text");
      expect((r as { content: string }).content.match(/chunk-\d+/g)).toHaveLength(5);
    });
    test("defaults to twenty chunks", () => {
      const r = resolveReply(user("[[mock:long-stream]] go"));
      expect((r as { content: string }).content.match(/chunk-\d+/g)).toHaveLength(20);
    });
  });

  describe("think", () => {
    test("returns reasoning separate from the answer", () => {
      expect(resolveReply(user("[[mock:think]] q"))).toEqual({
        kind: "text",
        content: "thought about it",
        reasoning: "private reasoning that must never reach Slack",
      });
    });
  });
});
