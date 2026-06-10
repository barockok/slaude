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

describe("applyEmbeddingEnv", () => {
  test("maps EMBEDDING_URL/_API_KEY/_MODEL into brain config + litellm envs", async () => {
    const { applyEmbeddingEnv, embeddingConfigured } = await import("../src/knowledge/brain");
    const { readFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    rmSync(join(home, "config.json"), { force: true });
    process.env.EMBEDDING_URL = "https://api.openai.com/v1";
    process.env.EMBEDDING_API_KEY = "sk-test";
    process.env.EMBEDDING_MODEL = "text-embedding-3-small";
    process.env.EMBEDDING_DIMENSIONS = "1536";
    try {
      applyEmbeddingEnv();
      expect(process.env.LITELLM_BASE_URL).toBe("https://api.openai.com/v1");
      expect(process.env.LITELLM_API_KEY).toBe("sk-test");
      const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
      expect(cfg.embedding_model).toBe("litellm:text-embedding-3-small");
      expect(cfg.embedding_dimensions).toBe(1536);
      expect(embeddingConfigured()).toBe(true);
    } finally {
      delete process.env.EMBEDDING_URL;
      delete process.env.EMBEDDING_API_KEY;
      delete process.env.EMBEDDING_MODEL;
      delete process.env.EMBEDDING_DIMENSIONS;
      delete process.env.LITELLM_BASE_URL;
      delete process.env.LITELLM_API_KEY;
    }
  });

  test("never clobbers an existing embedding_model in config.json", async () => {
    const { applyEmbeddingEnv } = await import("../src/knowledge/brain");
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    writeFileSync(join(home, "config.json"), JSON.stringify({ embedding_model: "zeroentropyai:zembed-1" }));
    process.env.EMBEDDING_URL = "https://example.com/v1";
    try {
      applyEmbeddingEnv();
      const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
      expect(cfg.embedding_model).toBe("zeroentropyai:zembed-1");
    } finally {
      delete process.env.EMBEDDING_URL;
      delete process.env.LITELLM_BASE_URL;
    }
  });

  test("no-op without EMBEDDING_URL", async () => {
    const { applyEmbeddingEnv } = await import("../src/knowledge/brain");
    const { rmSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    rmSync(join(home, "config.json"), { force: true });
    applyEmbeddingEnv();
    expect(existsSync(join(home, "config.json"))).toBe(false);
    expect(process.env.LITELLM_BASE_URL).toBeUndefined();
  });
});
