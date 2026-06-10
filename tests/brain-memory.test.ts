import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainMemoryProvider } from "../src/memory/brain-provider";
import { brainCall, closeBrain } from "../src/knowledge/brain";
import { AGENT_SOURCE } from "../src/knowledge/scope";

const brainDir = mkdtempSync(join(tmpdir(), "slaude-brainmem-"));
process.env.SLAUDE_BRAIN_HOME = brainDir;

afterAll(async () => {
  await closeBrain();
  delete process.env.SLAUDE_BRAIN_HOME;
  rmSync(brainDir, { recursive: true, force: true });
});

describe("BrainMemoryProvider (integration)", () => {
  const mem = new BrainMemoryProvider();
  const sessionId = "11111111-2222-3333-4444-555555555555";

  test("prefetch on empty session returns null", async () => {
    expect(await mem.prefetch(sessionId)).toBeNull();
  }, 60_000);

  test("syncTurn persists; prefetch returns recent turns block", async () => {
    await mem.syncTurn({ sessionId, user: "what is the deploy cadence?", assistant: "weekly, thursdays" });
    await mem.syncTurn({ sessionId, user: "and the oncall?", assistant: "rotates monday" });
    const block = await mem.prefetch(sessionId);
    expect(block).toContain("<recent-turns>");
    expect(block).toContain("deploy cadence");
    expect(block).toContain("rotates monday");
  }, 60_000);

  test("conversation page lives in the agent source", async () => {
    const page = (await brainCall(
      "get_page",
      { slug: `conversations/${sessionId}` },
      { clientId: "agent", sourceId: AGENT_SOURCE, allowedSources: [AGENT_SOURCE] },
    )) as { slug: string } | null;
    expect(page?.slug).toBe(`conversations/${sessionId}`);
  }, 60_000);

  test("caps prefetch at recentTurnLimit", async () => {
    for (let i = 0; i < 8; i++) {
      await mem.syncTurn({ sessionId, user: `q${i}`, assistant: `a${i}` });
    }
    const block = (await mem.prefetch(sessionId))!;
    const count = (block.match(/<user>/g) ?? []).length;
    expect(count).toBeLessThanOrEqual(mem.recentTurnLimit);
    expect(block).toContain("q7"); // newest survives
  }, 60_000);

  test("never throws when brain breaks — prefetch null, syncTurn no-op", async () => {
    const broken = new BrainMemoryProvider({
      call: async () => { throw new Error("engine down"); },
    });
    expect(await broken.prefetch(sessionId)).toBeNull();
    await broken.syncTurn({ sessionId, user: "x", assistant: "y" }); // must not throw
  });
});
