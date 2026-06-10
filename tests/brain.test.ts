import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "slaude-brain-test-"));
process.env.SLAUDE_BRAIN_HOME = home;

import { brainCall, brainAdminCall, closeBrain, ensureSources, getBrain } from "../src/knowledge/brain";
import type { BrainScope } from "../src/knowledge/scope";

afterAll(async () => {
  await closeBrain();
  rmSync(home, { recursive: true, force: true });
});

const aliceScope: BrainScope = { clientId: "U_ALICE", sourceId: "user-ualice", allowedSources: ["user-ualice", "shared"] };
const bobScope: BrainScope = { clientId: "U_BOB", sourceId: "shared", allowedSources: ["shared"] };

describe("brain engine (integration)", () => {
  test("boots, ensures baseline sources", async () => {
    await getBrain();
    await ensureSources(["user-ualice"]);
    const listed = (await brainAdminCall("sources_list", {})) as { sources: Array<{ id: string }> };
    const ids = listed.sources.map((s) => s.id);
    for (const want of ["agent", "shared", "public", "user-ualice"]) expect(ids).toContain(want);
  }, 60_000);

  test("write lands in scope source; cross-scope read is empty", async () => {
    await brainCall("put_page", { slug: "notes/secret", content: "Alice private zanzibar fact." }, aliceScope);
    const mine = (await brainCall("search", { query: "zanzibar" }, aliceScope)) as unknown[];
    expect(mine.length).toBeGreaterThan(0);
    const theirs = (await brainCall("search", { query: "zanzibar" }, bobScope)) as unknown[];
    expect(theirs.length).toBe(0);
  }, 60_000);

  test("unknown op throws", async () => {
    expect(brainCall("nope_op", {}, aliceScope)).rejects.toThrow(/unknown brain op/);
  });
});

describe("embeddingConfigured", () => {
  test("false without config.json, true once embedding_model set", async () => {
    const { embeddingConfigured } = await import("../src/knowledge/brain");
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    expect(embeddingConfigured()).toBe(false);
    writeFileSync(join(home, "config.json"), JSON.stringify({ embedding_model: "zeroentropyai:zembed-1" }));
    expect(embeddingConfigured()).toBe(true);
  });
});
