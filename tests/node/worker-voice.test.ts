import { describe, it, expect } from "bun:test";
import { isInjectedTurnEnd } from "../../src/node/worker";
import { injectedTurns } from "../../src/voice/turn-flags";

describe("node event stream and injected (voice) turns", () => {
  it("keeps an injected turn's done/error off the gateway's event stream", () => {
    injectedTurns.enter("s1");
    try {
      expect(isInjectedTurnEnd({ type: "done", sessionId: "s1" } as any)).toBe(true);
      expect(isInjectedTurnEnd({ type: "error", sessionId: "s1", error: "x" } as any)).toBe(true);
      // Progress events still flow (a status line is allowed during a call).
      expect(isInjectedTurnEnd({ type: "toolCall", sessionId: "s1" } as any)).toBe(false);
      // Other sessions are untouched.
      expect(isInjectedTurnEnd({ type: "done", sessionId: "s2" } as any)).toBe(false);
    } finally {
      injectedTurns.exit("s1");
    }
    expect(isInjectedTurnEnd({ type: "done", sessionId: "s1" } as any)).toBe(false);
  });
});
