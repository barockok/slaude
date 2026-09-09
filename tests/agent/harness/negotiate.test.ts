import { describe, it, expect } from "bun:test";
import { negotiate, formatNegotiation, assertUsable, type Feature } from "../../../src/agent/harness/capabilities";
import { CLAUDE_CAPS, CODEX_CAPS, PI_CAPS, DESCRIPTORS } from "../../../src/agent/harness/adapters/descriptors";
import type { HarnessCapabilities } from "../../../src/agent/harness/types";

const find = <T extends { feature: Feature }>(fs: T[], f: Feature): T | undefined =>
  fs.find((x) => x.feature === f);

describe("negotiate", () => {
  it("finds nothing to degrade on the reference harness", () => {
    const n = negotiate(CLAUDE_CAPS);
    expect(n.degraded).toEqual([]);
    expect(n.blockers).toEqual([]);
    expect(n.native).toContain("approval-gate");
    expect(n.native).toContain("surface-tools");
  });

  it("bridges surface tools when a harness cannot host them in-process", () => {
    const n = negotiate(CODEX_CAPS);
    const f = find(n.degraded, "surface-tools");
    expect(f).toBeDefined();
    expect(f!.fallback.kind).toBe("emulate");
    expect(n.blockers.map((b) => b.feature)).not.toContain("surface-tools");
  });

  it("blocks a harness with no in-process tools and no MCP transport", () => {
    const caps: HarnessCapabilities = {
      ...PI_CAPS,
      tools: { inProcess: false, mcpStdio: false, mcpHttp: false },
    };
    const n = negotiate(caps);
    const f = find(n.blockers, "surface-tools");
    expect(f).toBeDefined();
    expect(f!.fallback.kind).toBe("none");
  });

  it("treats a missing interactive approval gate as unbootable, not as a degradation", () => {
    const n = negotiate(PI_CAPS);
    expect(n.blockers.map((b) => b.feature)).toContain("approval-gate");
    expect(() => assertUsable(n)).toThrow(/approval-gate/);
  });

  it("lets a hook-based gate through as degraded, since it can still deny", () => {
    const n = negotiate(CODEX_CAPS);
    const f = find(n.degraded, "approval-gate");
    expect(f?.fallback.kind).toBe("degrade");
    expect(n.blockers.map((b) => b.feature)).not.toContain("approval-gate");
  });

  it("honours an explicit opt-out instead of blocking", () => {
    const n = negotiate(PI_CAPS, { disabled: ["approval-gate"] });
    expect(n.blockers).toEqual([]);
    expect(n.native).not.toContain("approval-gate");
    expect(n.degraded.map((d) => d.feature)).not.toContain("approval-gate");
    expect(() => assertUsable(n)).not.toThrow();
  });

  it("degrades disengage-suppression when a hook cannot halt after persisting", () => {
    const caps: HarnessCapabilities = {
      ...CLAUDE_CAPS,
      hookDecisions: { ...CLAUDE_CAPS.hookDecisions, halt: false },
    };
    const f = find(negotiate(caps).degraded, "disengage-suppression");
    expect(f?.reason).toMatch(/halt/);
    expect(f?.fallback.kind).toBe("degrade");
  });

  it("degrades the stop guard to advisory when block is unavailable", () => {
    const caps: HarnessCapabilities = {
      ...CLAUDE_CAPS,
      hookDecisions: { ...CLAUDE_CAPS.hookDecisions, block: false },
    };
    const f = find(negotiate(caps).degraded, "stop-guard");
    expect(f?.fallback).toEqual({ kind: "degrade", loses: "guard becomes advisory — logged, not enforced" });
  });

  it("emulates per-turn context injection by prepending to the message", () => {
    const caps: HarnessCapabilities = { ...CLAUDE_CAPS, hooks: ["turnEnd"] };
    const f = find(negotiate(caps).degraded, "out-of-band-context");
    expect(f?.fallback.kind).toBe("emulate");
  });

  it("writes the system prompt to a file when that is the only path", () => {
    const f = find(negotiate(PI_CAPS).degraded, "persona-prompt");
    expect(f?.fallback).toMatchObject({ kind: "emulate", how: expect.stringContaining("instructions file") });
  });

  it("queues turns when a harness has no streaming input", () => {
    const f = find(negotiate(CODEX_CAPS).degraded, "live-multiturn");
    expect(f?.fallback).toMatchObject({ kind: "emulate", how: expect.stringContaining("one turn at a time") });
  });

  it("classifies every requirement exactly once", () => {
    for (const caps of Object.values(DESCRIPTORS)) {
      const n = negotiate(caps);
      const all = [...n.native, ...n.degraded.map((d) => d.feature), ...n.blockers.map((b) => b.feature)];
      expect(new Set(all).size).toBe(all.length);
      expect(all.length).toBe(11);
    }
  });
});

describe("formatNegotiation", () => {
  it("summarises counts and explains each non-native feature", () => {
    const out = formatNegotiation(negotiate(CODEX_CAPS));
    expect(out).toContain("[harness] codex:");
    expect(out).toContain("surface-tools");
    expect(out.split("\n").length).toBeGreaterThan(1);
  });

  it("marks blockers distinctly from degradations", () => {
    const out = formatNegotiation(negotiate(PI_CAPS));
    expect(out).toMatch(/approval-gate: BLOCKED/);
  });
});
