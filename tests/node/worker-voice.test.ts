import { describe, it, expect } from "bun:test";
import { keepOffEventStream } from "../../src/node/worker";
import { injectedTurns, voiceTurns } from "../../src/voice/turn-flags";

describe("node event stream and injected (voice) turns", () => {
  it("keeps an injected turn's done/error off the gateway's event stream", () => {
    injectedTurns.enter("s1");
    try {
      expect(keepOffEventStream({ type: "done", sessionId: "s1" } as any)).toBe(true);
      expect(keepOffEventStream({ type: "error", sessionId: "s1", error: "x" } as any)).toBe(true);
      // A non-voice injected turn (the summary) still shows progress.
      expect(keepOffEventStream({ type: "toolCall", sessionId: "s1" } as any)).toBe(false);
      // Other sessions are untouched.
      expect(keepOffEventStream({ type: "done", sessionId: "s2" } as any)).toBe(false);
    } finally {
      injectedTurns.exit("s1");
    }
    expect(keepOffEventStream({ type: "done", sessionId: "s1" } as any)).toBe(false);
  });

  it("keeps every event of a voice turn off the stream (a follower would replay it into the thread)", () => {
    injectedTurns.enter("s1");
    voiceTurns.enter("s1");
    try {
      for (const type of ["toolCall", "toolResult", "chunk", "thinking", "done", "error"]) {
        expect(keepOffEventStream({ type, sessionId: "s1" } as any)).toBe(true);
      }
      expect(keepOffEventStream({ type: "toolCall", sessionId: "s2" } as any)).toBe(false);
    } finally {
      voiceTurns.exit("s1");
      injectedTurns.exit("s1");
    }
    expect(keepOffEventStream({ type: "toolCall", sessionId: "s1" } as any)).toBe(false);
  });
});
