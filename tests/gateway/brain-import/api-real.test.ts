// Real PGLite brain behind the endpoint: engine, ensureSource and the embedding
// dimension all come from the real code paths; only env, agent id and log are injected.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_DIMS, vec } from "../../brain-migrate/seed";

const home = mkdtempSync(join(tmpdir(), "bm-import-real-"));
process.env.SLAUDE_BRAIN_HOME = home;
import { closeBrain, getBrain } from "../../../src/knowledge/brain";
import { createBrainImportApi } from "../../../src/gateway/brain-import/api";
import type { BundlePage } from "../../../src/brain-migrate/bundle";
import type { MigrateEngine } from "../../../src/brain-migrate/engine-types";

afterAll(async () => { await closeBrain(); rmSync(home, { recursive: true, force: true }); });

const TOKEN = "r".repeat(40);
const pg = (source: string, slug: string, truth: string, seed: number): BundlePage => ({
  source, slug, type: "note", title: slug, compiledTruth: truth, timeline: "", frontmatter: {}, contentHash: null,
  chunks: [{ index: 0, text: truth, source: "compiled_truth", embedding: vec(seed), model: null, tokens: 3 }],
  tags: ["t1"], timelineEntries: [], raw: [], links: [],
});
const api = createBrainImportApi({
  env: () => ({ SLAUDE_BRAIN_IMPORT_TOKEN: TOKEN }),
  resolveAgentId: async (n) => (n === "ana" ? "UANA-1x" : null),
  log: () => {},
});
const post = async (pages: BundlePage[], dims = TEST_DIMS) => {
  const r = await api.fetch(new Request("https://gw.example.com/brain-import/v1/personas/ana", {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ engine: { embeddingModel: null, embeddingDimensions: dims }, pages }),
  }));
  return { status: r!.status, json: (await r!.json()) as any };
};

describe("/brain-import against a real brain", () => {
  test("lands pages in the persona's slice and the person's slice with embeddings intact; a repeat skips", async () => {
    const pages = [pg("agent-default", "learned/one", "agent body", 1), pg("user-ualice", "prefs/two", "alice body", 2)];
    const r = await post(pages);
    expect(r.status).toBe(200);
    expect(r.json.agentSource).toBe("agent-uana1x");
    expect(r.json.sources["agent-uana1x"].written).toBe(1);
    expect(r.json.sources["user-ualice"].written).toBe(1);

    const engine = (await getBrain()) as unknown as MigrateEngine;
    const a = await engine.getChunksWithEmbeddings("learned/one", { sourceId: "agent-uana1x" });
    expect(Array.from(a[0]!.embedding!)[5]).toBeCloseTo(vec(1)[5]!, 5);
    const u = await engine.getChunksWithEmbeddings("prefs/two", { sourceId: "user-ualice" });
    expect(Array.from(u[0]!.embedding!)[5]).toBeCloseTo(vec(2)[5]!, 5);
    expect(await engine.getTags("prefs/two", { sourceId: "user-ualice" })).toEqual(["t1"]);
    expect(await engine.getPage("learned/one", { sourceId: "agent-default" })).toBeNull();

    const again = await post(pages);
    expect(again.json.sources["agent-uana1x"].skipped).toBe(1);
    expect(again.json.sources["user-ualice"].skipped).toBe(1);
  }, 120_000);

  test("a bundle of another dimension is refused against the real column width", async () => {
    const r = await post([pg("shared", "x", "x", 3)], 1536);
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/1536/); expect(r.json.error).toMatch(new RegExp(String(TEST_DIMS)));
  }, 60_000);
});
