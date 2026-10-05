/**
 * The mono scoped memory provider settles the process agent identity
 * (agentIdReady) BEFORE it computes a scope: a scope computed earlier would be
 * keyed on an identity not yet known. A failing ready() skips memory.
 */
import { describe, expect, test } from "bun:test";
import { makeScopedMemory } from "../../src/memory/scoped";
import { BrainMemoryProvider } from "../../src/memory/brain-provider";
import { fakeBrain } from "./fake-brain";

const scopeOf = (source: string) => ({ read: { sourceId: source, allowedSources: [source] }, write: { sourceId: source, allowedSources: [source] } }) as never;

describe("makeScopedMemory awaits ready() before every scope", () => {
  for (const op of ["prefetch", "syncTurn"] as const) {
    test(`${op}: scopeFor runs only after ready() settled`, async () => {
      const fb = fakeBrain();
      const provider = new BrainMemoryProvider({ call: fb.call, ready: async () => {} });
      let settled = false;
      const seen: boolean[] = [];
      const m = makeScopedMemory({
        provider: () => provider,
        ready: () => new Promise<void>((r) => setTimeout(() => { settled = true; r(); }, 20)),
        scopeFor: async () => { seen.push(settled); return scopeOf("agent-x"); },
        warn: () => {},
      });
      if (op === "prefetch") await m.prefetch("S1");
      else await m.syncTurn({ sessionId: "S1", user: "hi", assistant: "hello" } as never);
      expect(seen).toEqual([true]);
    });
  }

  test("a ready() that fails reads and writes nothing, and warns", async () => {
    const fb = fakeBrain();
    const provider = new BrainMemoryProvider({ call: fb.call, ready: async () => {} });
    const warns: string[] = [];
    let asked = 0;
    const m = makeScopedMemory({
      provider: () => provider,
      ready: async () => { throw new Error("identity unknown"); },
      scopeFor: async () => { asked++; return scopeOf("agent-x"); },
      warn: (w) => void warns.push(w),
    });
    expect(await m.prefetch("S1")).toBeNull();
    await m.syncTurn({ sessionId: "S1", user: "hi", assistant: "hello" } as never);
    expect(asked).toBe(0);
    expect(fb.sourcesOf("S1")).toEqual([]);
    expect(warns.length).toBe(2);
  });
});
