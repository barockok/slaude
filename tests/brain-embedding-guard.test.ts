import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allowEmbeddingRealign,
  closeBrain,
  configuredEmbeddingModel,
  embeddingActive,
  embeddingRefusal,
  getBrain,
  runAdminOp,
} from "../src/knowledge/brain";
import {
  embeddingGuardVerdict,
  installChunkModelStamp,
  normalizeEmbeddingModel,
} from "../src/knowledge/embedding-guard";
import { formatReembedReport, reembedModelMismatch, runReembedCommand, type ReembedEngine } from "../src/knowledge/brain-reembed";

const OPENAI = "openai:text-embedding-3-small";
const DEFAULT_LABEL = "zeroentropyai:zembed-1";
const DIMS = 1280;

const gbrainImport = (subpath: string): Promise<Record<string, unknown>> =>
  import(("gbrain/" + subpath) as string) as Promise<Record<string, unknown>>;

type Gw = { __setEmbedTransportForTests: (fn: unknown) => void };
type Db = { db: { query: (sql: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> } };
type ConfigEngine = { setConfig: (k: string, v: string) => Promise<void>; upsertChunks: (s: string, c: object[], o?: object) => Promise<void> };

let home: string | null = null;
let embedCalls = 0;

afterEach(async () => {
  allowEmbeddingRealign(false);
  await closeBrain();
  for (const k of ["SLAUDE_BRAIN_HOME", "EMBEDDING_PROVIDER", "EMBEDDING_MODEL", "EMBEDDING_DIMENSIONS", "EMBEDDING_API_KEY", "OPENAI_API_KEY", "SLAUDE_BRAIN_MODE"]) {
    delete process.env[k];
  }
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
});

function configure(): void {
  if (!home) {
    home = mkdtempSync(join(tmpdir(), "slaude-embedguard-"));
    process.env.SLAUDE_BRAIN_HOME = home;
  }
  process.env.EMBEDDING_PROVIDER = "openai";
  process.env.EMBEDDING_MODEL = "text-embedding-3-small";
  process.env.EMBEDDING_DIMENSIONS = String(DIMS);
  process.env.EMBEDDING_API_KEY = "sk-test-placeholder";
}

async function stubTransport(): Promise<void> {
  embedCalls = 0;
  const gw = (await gbrainImport("ai/gateway")) as Gw;
  gw.__setEmbedTransportForTests(async ({ values }: { values: string[] }) => {
    embedCalls++;
    return { embeddings: values.map(() => Array(DIMS).fill(0.01)), usage: { tokens: 1 } };
  });
}

async function chunkRows(engine: unknown): Promise<Array<{ model: string; nul: boolean }>> {
  const r = await (engine as Db).db.query("SELECT model, embedding IS NULL AS nul FROM content_chunks ORDER BY id");
  return r.rows as Array<{ model: string; nul: boolean }>;
}

const PAGE = "---\ntype: note\n---\n# Note\n\nsome body text for one chunk";

describe("embeddingGuardVerdict", () => {
  const base = { configured: OPENAI, configuredDims: DIMS, stored: OPENAI, storedDims: DIMS, gateway: OPENAI };
  test("passes when everything agrees, or nothing is configured", () => {
    expect(embeddingGuardVerdict(base)).toBeNull();
    expect(embeddingGuardVerdict({ ...base, configured: null, stored: DEFAULT_LABEL })).toBeNull();
    expect(embeddingGuardVerdict({ ...base, stored: null, storedDims: null, gateway: null })).toBeNull();
  });
  test("refuses a brain recorded with another model", () => {
    expect(embeddingGuardVerdict({ ...base, stored: DEFAULT_LABEL })).toContain(`brain embedding_model is ${DEFAULT_LABEL}`);
  });
  test("refuses a gateway on another model", () => {
    expect(embeddingGuardVerdict({ ...base, gateway: DEFAULT_LABEL })).toContain("gateway model");
  });
  test("refuses other dimensions", () => {
    expect(embeddingGuardVerdict({ ...base, storedDims: 1536 })).toContain("embedding_dimensions is 1536");
  });
  test("reads a legacy bare model name as openai", () => {
    expect(normalizeEmbeddingModel("text-embedding-3-small")).toBe(OPENAI);
    expect(normalizeEmbeddingModel("  ")).toBeNull();
    expect(embeddingGuardVerdict({ ...base, stored: "text-embedding-3-small" })).toBeNull();
  });
});

describe("installChunkModelStamp", () => {
  function fakeEngine() {
    const seen: Array<Array<Record<string, unknown>>> = [];
    const engine = {
      async upsertChunks(_slug: string, chunks: Array<Record<string, unknown>>) {
        seen.push(chunks);
      },
    };
    return { engine, seen };
  }

  test("labels unlabelled chunks with the brain model, keeps explicit labels", async () => {
    const { engine, seen } = fakeEngine();
    installChunkModelStamp(engine, { brainModel: () => OPENAI, gatewayModel: () => OPENAI });
    installChunkModelStamp(engine, { brainModel: () => "x:y", gatewayModel: () => "x:y" }); // idempotent
    await engine.upsertChunks("a", [{ chunk_index: 0, embedding: [1] }, { chunk_index: 1 }, { chunk_index: 2, model: "voyage:voyage-3" }]);
    expect(seen[0]!.map((c) => c.model)).toEqual([OPENAI, OPENAI, "voyage:voyage-3"]);
    expect(seen[0]![0]!.embedding).toEqual([1]);
  });

  test("strips a vector the gateway made with another model, and says so", async () => {
    const { engine, seen } = fakeEngine();
    const refused: string[] = [];
    installChunkModelStamp(engine, { brainModel: () => OPENAI, gatewayModel: () => DEFAULT_LABEL, onRefuse: (m) => refused.push(m) });
    await engine.upsertChunks("a", [{ chunk_index: 0, embedding: [1] }]);
    expect(seen[0]![0]).toEqual({ chunk_index: 0, model: OPENAI });
    expect(refused[0]).toContain("REFUSED an embedding for a");
  });

  test("default refusal logs loudly", async () => {
    const { engine, seen } = fakeEngine();
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      installChunkModelStamp(engine, { brainModel: () => OPENAI, gatewayModel: () => DEFAULT_LABEL });
      await engine.upsertChunks("b", [{ chunk_index: 0, embedding: [1] }]);
      expect(seen[0]![0]!.embedding).toBeUndefined();
      expect(String(err.mock.calls[0]![0])).toContain(`gateway model ${DEFAULT_LABEL}`);
    } finally {
      err.mockRestore();
    }
  });

  test("with no gateway a carried-in vector (bundle import) is kept and labelled", async () => {
    const { engine, seen } = fakeEngine();
    installChunkModelStamp(engine, { brainModel: () => OPENAI, gatewayModel: () => null });
    await engine.upsertChunks("c", [{ chunk_index: 0, embedding: [1] }]);
    expect(seen[0]![0]).toEqual({ chunk_index: 0, embedding: [1], model: OPENAI });
  });

  test("passes through when the brain has no model, and skips a non-engine", async () => {
    const { engine, seen } = fakeEngine();
    installChunkModelStamp(engine, { brainModel: () => null, gatewayModel: () => null });
    await engine.upsertChunks("a", [{ chunk_index: 0, embedding: [1] }]);
    expect(seen[0]![0]).toEqual({ chunk_index: 0, embedding: [1] });
    expect(() => installChunkModelStamp({}, { brainModel: () => null, gatewayModel: () => null })).not.toThrow();
  });
});

describe("brain writes use the configured embedding model", () => {
  test("put_page embeds with the configured provider and labels the chunk with it", async () => {
    configure();
    await getBrain();
    await stubTransport();
    expect(embeddingActive()).toBe(true);
    expect(configuredEmbeddingModel()).toBe(OPENAI);
    await runAdminOp("put_page", { slug: "notes/one", content: PAGE });
    expect(embedCalls).toBeGreaterThan(0);
    const rows = await chunkRows(await getBrain());
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).toEqual({ model: OPENAI, nul: false });
  }, 60_000);

  test("guard: a brain recorded with another model refuses to embed; writes land unembedded", async () => {
    configure();
    const first = (await getBrain()) as unknown as ConfigEngine;
    await first.setConfig("embedding_model", DEFAULT_LABEL);
    await closeBrain();
    configure();
    const err = spyOn(console, "error").mockImplementation(() => {});
    let engine: unknown;
    try {
      engine = await getBrain();
      expect(err.mock.calls.some((c) => String(c[0]).includes("EMBEDDING REFUSED"))).toBe(true);
    } finally {
      err.mockRestore();
    }
    expect(embeddingActive()).toBe(false);
    expect(embeddingRefusal()).toContain(`brain embedding_model is ${DEFAULT_LABEL}`);
    await runAdminOp("put_page", { slug: "notes/two", content: PAGE });
    const rows = await chunkRows(engine);
    for (const r of rows) expect(r).toEqual({ model: OPENAI, nul: true });
    await expect(runReembedCommand({ apply: false })).rejects.toThrow("brain embedding_model");
  }, 60_000);

  test("a process with no embedding config labels writes with the brain's own model", async () => {
    configure();
    await getBrain();
    await closeBrain();
    for (const k of ["EMBEDDING_PROVIDER", "EMBEDDING_MODEL", "EMBEDDING_DIMENSIONS", "EMBEDDING_API_KEY", "OPENAI_API_KEY"]) delete process.env[k];
    // config.json in the brain home still names the model; drop the key so the gateway stays off
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const engine = await getBrain();
      expect(embeddingActive()).toBe(false);
      await runAdminOp("put_page", { slug: "notes/three", content: PAGE });
      for (const r of await chunkRows(engine)) expect(r).toEqual({ model: OPENAI, nul: true });
      await expect(runReembedCommand({ apply: true })).rejects.toThrow("embedding gateway inactive");
    } finally {
      warn.mockRestore();
    }
  }, 60_000);
});

describe("slaude brain reembed --model-mismatch", () => {
  test("dry run reports mislabelled chunks; apply re-embeds and relabels them", async () => {
    configure();
    const engine = (await getBrain()) as unknown as ConfigEngine;
    await stubTransport();
    await runAdminOp("put_page", { slug: "notes/good", content: PAGE });
    await runAdminOp("put_page", { slug: "notes/bad", content: PAGE });
    // A chunk labelled with gbrain's default, as gbrain wrote it before the stamp.
    await engine.upsertChunks("notes/bad", [{ chunk_index: 0, chunk_text: "some body text for one chunk", chunk_source: "compiled_truth", model: DEFAULT_LABEL }], { sourceId: "default" });

    const dry = await runReembedCommand({ apply: false });
    expect(dry.chunksMismatched).toBe(1);
    expect(dry.pages.map((p) => p.slug)).toEqual(["notes/bad"]);
    expect(dry.byModel).toEqual({ [DEFAULT_LABEL]: 1 });
    expect(formatReembedReport(dry)).toContain("dry run: nothing changed");
    expect((await chunkRows(engine)).some((r) => r.model === DEFAULT_LABEL)).toBe(true);

    embedCalls = 0;
    const logs: string[] = [];
    const done = await runReembedCommand({ apply: true, sourceIds: ["default"], log: (m) => logs.push(m) });
    expect(done.pagesReembedded).toBe(1);
    expect(embedCalls).toBe(1);
    expect(logs.join("\n")).toContain("re-embedded default/notes/bad");
    expect(formatReembedReport(done)).toContain("re-embedded 1 chunk(s) on 1 page(s)");
    for (const r of await chunkRows(engine)) expect(r).toEqual({ model: OPENAI, nul: false });
    expect((await runReembedCommand({ apply: false })).chunksMismatched).toBe(0);
  }, 60_000);

  test("refuses without a configured model, and in remote mode", async () => {
    home = mkdtempSync(join(tmpdir(), "slaude-embedguard-"));
    process.env.SLAUDE_BRAIN_HOME = home;
    await expect(runReembedCommand({ apply: false })).rejects.toThrow("no embedding model configured");
    await closeBrain();
    process.env.SLAUDE_BRAIN_MODE = "remote";
    await expect(runReembedCommand({ apply: false })).rejects.toThrow("SLAUDE_BRAIN_MODE=remote");
  }, 60_000);

  test("refuses a dimension mismatch", async () => {
    configure();
    const engine = (await getBrain()) as unknown as ConfigEngine;
    await engine.setConfig("embedding_dimensions", "1536");
    await closeBrain();
    configure();
    allowEmbeddingRealign(true);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(runReembedCommand({ apply: false })).rejects.toThrow("cannot change the vector column width");
    } finally {
      warn.mockRestore();
    }
  }, 60_000);
});

describe("reembedModelMismatch core", () => {
  function memEngine(brainModel: string | null) {
    const config = new Map<string, string>(brainModel ? [["embedding_model", brainModel]] : []);
    const chunks = new Map<string, Array<{ chunk_index: number; chunk_text: string; chunk_source: string; model: string | null; embedding: unknown }>>([
      ["a", [{ chunk_index: 0, chunk_text: "x", chunk_source: "compiled_truth", model: OPENAI, embedding: [1] }]],
      ["b", [{ chunk_index: 0, chunk_text: "y", chunk_source: "compiled_truth", model: OPENAI, embedding: [1] }]],
    ]);
    const engine: ReembedEngine = {
      async listPages({ offset }) {
        return offset === 0 ? [...chunks.keys()].map((slug) => ({ slug })) : [];
      },
      async getChunks(slug) {
        return chunks.get(slug) ?? [];
      },
      async upsertChunks(slug, cs) {
        if (slug === "b" && config.get("fail") === "1") throw new Error("boom");
        chunks.set(slug, cs as never);
      },
      async setPageEmbeddingSignature() {},
      async getConfig(k) {
        return config.get(k) ?? null;
      },
      async setConfig(k, v) {
        config.set(k, v);
      },
    };
    return { engine, config };
  }
  const deps = (engine: ReembedEngine) => ({
    engine, target: OPENAI, targetDims: DIMS, sourceIds: ["default"],
    embed: async (t: string[]) => t.map(() => new Float32Array(DIMS)), signature: () => `${OPENAI}:${DIMS}`,
  });

  test("a brain recorded with another model is re-embedded whole, then recorded as the configured one", async () => {
    const { engine, config } = memEngine(DEFAULT_LABEL);
    const dry = await reembedModelMismatch(deps(engine), false);
    expect(dry.pages.length).toBe(2);
    const r = await reembedModelMismatch(deps(engine), true);
    expect(r.brainModelUpdated).toBe(true);
    expect(config.get("embedding_model")).toBe(OPENAI);
    expect(config.get("embedding_dimensions")).toBe(String(DIMS));
    expect(formatReembedReport(r)).toContain(`brain record set to ${OPENAI}`);
  });

  test("a failed page is reported and the brain record is left alone", async () => {
    const { engine, config } = memEngine(DEFAULT_LABEL);
    config.set("fail", "1");
    const r = await reembedModelMismatch(deps(engine), true);
    expect(r.errors.map((e) => e.slug)).toEqual(["b"]);
    expect(r.brainModelUpdated).toBe(false);
    expect(formatReembedReport(r)).toContain("FAILED default/b: boom");
  });

  test("long reports are truncated", async () => {
    const r = await reembedModelMismatch(deps(memEngine(OPENAI).engine), false);
    const many = { ...r, pages: Array.from({ length: 52 }, (_, i) => ({ sourceId: "s", slug: `p${i}`, chunks: 1, mismatched: 1 })) };
    expect(formatReembedReport(many)).toContain("... 2 more");
  });
});
