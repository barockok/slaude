import { describe, it, expect } from "bun:test";
import { sigintAction } from "../../../src/gateway/sim/interrupt";

describe("sigintAction — Ctrl-C at the prompt", () => {
  it("clears a non-empty line and drops any pending-exit", () => {
    expect(sigintAction(false, 5)).toEqual({ action: "clear", pending: false });
    expect(sigintAction(true, 5)).toEqual({ action: "clear", pending: false });
  });

  it("first Ctrl-C on an empty line warns and arms exit", () => {
    expect(sigintAction(false, 0)).toEqual({ action: "warn", pending: true });
  });

  it("second consecutive Ctrl-C on an empty line exits", () => {
    expect(sigintAction(true, 0)).toEqual({ action: "exit", pending: false });
  });
});
