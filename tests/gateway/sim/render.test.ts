import { describe, it, expect } from "bun:test";
import {
  toolLine, resultLine, replyLine, errorLine, statusLabel, gateBox, SPINNER_FRAMES,
  thinkingLine, usageLine, budgetView,
} from "../../../src/gateway/sim/render";
import type { AgentEvent } from "../../../src/agent/manager";
import type { OutboundCard } from "../../../src/gateway/sim/transport";

const ev = (e: Partial<AgentEvent>): AgentEvent => ({ sessionId: "s", ...(e as any) });

describe("render formatters", () => {
  it("toolLine shows short tool name + summarized arg", () => {
    expect(toolLine("mcp__x__Bash", { command: "ls -la" })).toBe("⏺ Bash(ls -la)");
  });

  it("toolLine truncates long args", () => {
    const long = "x".repeat(200);
    const out = toolLine("Read", { file_path: long });
    expect(out.length).toBeLessThan(100);
    expect(out.endsWith("…)")).toBe(true);
  });

  it("resultLine indents under the tool with the ⎿ glyph, first line only", () => {
    expect(resultLine("first\nsecond")).toBe("  ⎿ first");
  });

  it("resultLine handles empty", () => {
    expect(resultLine("")).toBe("  ⎿ (empty)");
  });

  it("replyLine prefixes the assistant bullet", () => {
    expect(replyLine("hi there")).toBe("⏺ hi there");
  });

  it("errorLine prefixes a warning glyph", () => {
    expect(errorLine("boom")).toContain("boom");
    expect(errorLine("boom").startsWith("⚠")).toBe(true);
  });

  describe("statusLabel — live activity text per event", () => {
    it("thinking → Thinking…", () => {
      expect(statusLabel(ev({ type: "thinking", text: "hmm" }))).toBe("Thinking…");
    });
    it("toolCall → Running <tool>…", () => {
      expect(statusLabel(ev({ type: "toolCall", tool: "mcp__x__Bash", input: {} }))).toBe("Bash…");
    });
    it("assistantText → Writing…", () => {
      expect(statusLabel(ev({ type: "assistantText", text: "x" }))).toBe("Writing…");
    });
    it("toolResult / done / error → null (no live label)", () => {
      expect(statusLabel(ev({ type: "toolResult", tool: "Bash", result: "x" }))).toBeNull();
      expect(statusLabel(ev({ type: "done" }))).toBeNull();
      expect(statusLabel(ev({ type: "error", error: "x" }))).toBeNull();
    });
  });

  describe("gateBox", () => {
    const card = (over: Partial<OutboundCard>): OutboundCard => ({
      kind: "permission", channel: "C", actionIds: ["slaude_perm:allow", "slaude_perm:always", "slaude_perm:deny"],
      resolved: false, raw: {}, text: "needs `mcp__x__Bash`", ...over,
    });
    it("draws a bordered box with the tool and numbered options", () => {
      const box = gateBox(card({}));
      expect(box).toContain("Bash");
      expect(box).toMatch(/1\.\s/);       // numbered options
      expect(box).toContain("allow");
      expect(box).toContain("deny");
      expect(box.split("\n").length).toBeGreaterThanOrEqual(3);  // multi-line box
    });
    it("approval kind labels as approval, omits always when not offered", () => {
      const box = gateBox(card({ kind: "approval", actionIds: ["slaude_appr:approve", "slaude_appr:reject"], text: "approve this action" }));
      expect(box.toLowerCase()).toContain("approval");
      expect(box).not.toContain("always");
    });
  });

  it("SPINNER_FRAMES is a non-empty frame list", () => {
    expect(SPINNER_FRAMES.length).toBeGreaterThan(1);
  });

  describe("thinkingLine", () => {
    it("prefixes a thinking glyph and keeps the text", () => {
      const out = thinkingLine("let me reason about this");
      expect(out).toContain("let me reason about this");
      expect(out).toContain("✻");
    });
    it("collapses whitespace and trims", () => {
      expect(thinkingLine("  a\n\n  b  ")).toContain("a b");
    });
  });

  describe("usageLine", () => {
    const snap = { inputTokens: 1200, outputTokens: 340, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, totalInput: 1200, contextWindow: 200000, pctUsed: 0.08, remaining: 184000 };
    it("formats tokens with k-suffix and a context percentage", () => {
      const out = usageLine(snap as any);
      expect(out).toContain("1.2k");      // input tokens
      expect(out).toContain("340");       // output tokens
      expect(out).toContain("8%");        // ctx pct
    });
    it("renders small counts without a k-suffix", () => {
      const out = usageLine({ ...snap, inputTokens: 900, outputTokens: 12 } as any);
      expect(out).toContain("900");
      expect(out).toContain("12");
    });
  });

  describe("budgetView", () => {
    const snap = { inputTokens: 1200, outputTokens: 340, cacheReadInputTokens: 50, cacheCreationInputTokens: 10, totalInput: 1260, contextWindow: 200000, pctUsed: 0.08, remaining: 184000 };
    it("shows context window usage, percent, and remaining", () => {
      const out = budgetView(snap as any);
      expect(out).toContain("200k");      // context window
      expect(out).toContain("8%");        // pct
      expect(out).toContain("184k");      // remaining
    });
    it("breaks down input/output/cache tokens", () => {
      const out = budgetView(snap as any);
      expect(out).toContain("in");
      expect(out).toContain("out");
      expect(out.toLowerCase()).toContain("cache");
    });
  });
});
