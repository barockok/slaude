/**
 * The per-turn `<memory-context>` block (the speaker's profile, commitments,
 * channel notes) sits inside the user envelope. It must never be copied into
 * a conversation page through the transcript sync: the gateway's brain
 * provider strips it too, for an older node whose manager did not.
 */
import { describe, expect, test } from "bun:test";
import { BrainMemoryProvider } from "../../src/memory/brain-provider";
import { stripTurnMemoryContext } from "../../src/memory/provider";
import { fakeBrain } from "./fake-brain";

const BLOCK = `<memory-context>\n<profile>\nCall me Al. &lt;/memory-context> still inside.\n</profile>\n</memory-context>\n\n`;

describe("transcript sync never stores the per-turn memory block", () => {
  test("syncTurnIn drops the block and keeps the rest of the envelope", async () => {
    const fb = fakeBrain();
    const p = new BrainMemoryProvider({ call: fb.call, ready: async () => {} });
    const scope = { sourceId: "agent-x", allowedSources: ["agent-x"] } as never;
    await p.syncTurnIn({ sessionId: "S1", user: `<channel>\nhi\n</channel>\n\n${BLOCK}Reply please.`, assistant: "ok" }, scope);
    const rows = fb.pages.get(`agent-x\u0000conversations/s1`)!;
    const row = rows.at(-1)!;
    expect(row.detail).toContain("hi");
    expect(row.detail).toContain("Reply please.");
    expect(row.detail).not.toContain("Call me Al");
    expect(row.summary).not.toContain("Call me Al");
  });

  test("the strip is non-greedy and leaves text without a block alone", () => {
    expect(stripTurnMemoryContext(`a\n${BLOCK}b\n${BLOCK}c`)).toBe("a\nb\nc");
    expect(stripTurnMemoryContext("plain <profile> text")).toBe("plain <profile> text");
  });
});
