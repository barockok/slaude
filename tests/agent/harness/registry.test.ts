import { describe, it, expect } from "bun:test";
import {
  capabilitiesFor,
  compareAll,
  registerAdapter,
  reportFor,
  resolveAdapter,
  selectedHarnessId,
} from "../../../src/agent/harness/registry";
import { CLAUDE_CAPS, PI_CAPS } from "../../../src/agent/harness/adapters/descriptors";
import type { HarnessAdapter } from "../../../src/agent/harness/types";

const fake = (caps: typeof CLAUDE_CAPS): HarnessAdapter => ({
  capabilities: caps,
  start: async () => {
    throw new Error("not implemented");
  },
});

describe("registry", () => {
  it("defaults to claude", () => {
    expect(selectedHarnessId(undefined)).toBe("claude");
    expect(selectedHarnessId("")).toBe("claude");
    expect(selectedHarnessId("  Codex ")).toBe("codex");
  });

  it("falls back to the descriptor when no adapter is registered", () => {
    expect(capabilitiesFor("codex")?.id).toBe("codex");
    expect(capabilitiesFor("nope")).toBeNull();
  });

  it("reports on a harness that has no adapter yet", () => {
    expect(reportFor("codex").degraded.length).toBeGreaterThan(0);
    expect(() => reportFor("nope")).toThrow(/unknown harness/);
  });

  it("refuses to resolve an unregistered harness, quoting the negotiation", () => {
    expect(() => resolveAdapter("codex")).toThrow(/no harness adapter registered/);
    expect(() => resolveAdapter("codex")).toThrow(/surface-tools/);
  });

  it("resolves a registered adapter that can host slaude", () => {
    registerAdapter(fake(CLAUDE_CAPS));
    expect(resolveAdapter("claude").capabilities.id).toBe("claude");
  });

  it("refuses a registered adapter that cannot, unless the feature is opted out", () => {
    registerAdapter(fake({ ...PI_CAPS, id: "pi-test" }));
    expect(() => resolveAdapter("pi-test")).toThrow(/cannot host slaude/);
    expect(resolveAdapter("pi-test", ["approval-gate"]).capabilities.id).toBe("pi-test");
  });

  it("compares every known harness", () => {
    const out = compareAll();
    for (const id of ["claude", "codex", "pi", "dsh"]) expect(out).toContain(`[harness] ${id}:`);
  });
});
