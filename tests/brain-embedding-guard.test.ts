import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allowEmbeddingRealign,
  closeBrain,
  configuredEmbeddingModel,
  embeddingActive,
  embeddingProbeSettled,
  embeddingRefusal,
  getBrain,
  runAdminOp,
} from "../src/knowledge/brain";
import {
  CARRIED_IN,
  bareEmbeddingModel,
  classifyEmbeddingRecord,
  cosineSimilarity,
  installChunkModelStamp,
  normalizeEmbeddingModel,
  probeEmbeddingRecord,
  type ProbeEngine,
} from "../src/knowledge/embedding-guard";
import {
  REPORT_PAGE_LIMIT,
  formatAdoptReport,
  formatReembedReport,
  reembedModelMismatch,
  runAdoptCommand,
  runReembedCommand,
  type ReembedEngine,
} from "../src/knowledge/brain-reembed";
import { applyPage } from "../src/brain-migrate/apply";
import type { BundlePage } from "../src/brain-migrate/bundle";
import type { MigrateEngine } from "../src/brain-migrate/engine-types";

const OPENAI = "openai:text-embedding-3-small";
const DEFAULT_LABEL = "zeroentropyai:zembed-1";
const DIMS = 1280;

const gbrainImport = (subpath: string): Promise<Record<string, unknown>> =>
  import(("gbrain/" + subpath) as string) as Promise<Record<string, unknown>>;

type Gw = { __setEmbedTransportForTests: (fn: unknown) => void };
type Db = { db: { query: (sql: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> } };
type TestEngine = {
  getConfig: (k: string) => Promise<string | null>;
  setConfig: (k: string, v: string) => Promise<void>;
  upsertChunks: (s: string, c: object[], o?: object) => Promise<void>;
  getChunks: (s: string, o?: object) => Promise<Array<{ model: string }>>;
  transaction: <T>(fn: (tx: TestEngine) => Promise<T>) => Promise<T>;
};

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

/**
 * One freshly initialised brain per file, copied for each test. A fresh
 * PGLite initdb gets slower with every one a process has run and falls off a
 * cliff after about two dozen (each then takes over 20 s under coverage),
 * while opening an existing data dir stays fast. The suite runs every file in
 * one process, so a file that initialises a brain per test slows the first
 * boots of every later file. Copying a template keeps this file at one initdb.
 */
let template: string | null = null;
async function templateHome(): Promise<string> {
  if (template) return template;
  const t = mkdtempSync(join(tmpdir(), "slaude-embedguard-tpl-"));
  process.env.SLAUDE_BRAIN_HOME = t;
  setEmbeddingEnv();
  await quiet(() => getBrain());
  await closeBrain();
  template = t;
  return t;
}
afterAll(() => {
  if (template) rmSync(template, { recursive: true, force: true });
});

/** A new brain home: a copy of the template (`withConfig: false` drops its config.json files). */
async function newHome(withConfig = true): Promise<string> {
  const tpl = await templateHome();
  const h = mkdtempSync(join(tmpdir(), "slaude-embedguard-"));
  cpSync(tpl, h, { recursive: true });
  if (!withConfig) {
    rmSync(join(h, "config.json"), { force: true });
    rmSync(join(h, ".gbrain"), { recursive: true, force: true });
  }
  return h;
}

function setEmbeddingEnv(provider = "openai"): void {
  process.env.EMBEDDING_PROVIDER = provider;
  process.env.EMBEDDING_MODEL = "text-embedding-3-small";
  process.env.EMBEDDING_DIMENSIONS = String(DIMS);
  process.env.EMBEDDING_API_KEY = "sk-test-placeholder";
}

async function configure(provider = "openai"): Promise<void> {
  if (!home) {
    home = await newHome();
    process.env.SLAUDE_BRAIN_HOME = home;
  }
  setEmbeddingEnv(provider);
}

/** A deterministic text -> vector "model"; another seed is another model. */
function fakeModel(seed: number): (text: string) => number[] {
  return (text) => {
    let h = seed;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
    const v: number[] = [];
    for (let i = 0; i < DIMS; i++) {
      h = (h * 1103515245 + 12345) >>> 0;
      v.push(((h >>> 8) % 2001) / 1000 - 1);
    }
    return v;
  };
}
const MODEL_A = fakeModel(7);
const MODEL_B = fakeModel(99);

/** Install before getBrain (closeBrain resets it; configureGateway keeps it), so the boot probe uses it. */
async function stubTransport(model: (t: string) => number[] = MODEL_A, fail = false): Promise<void> {
  embedCalls = 0;
  const gw = (await gbrainImport("ai/gateway")) as Gw;
  gw.__setEmbedTransportForTests(async ({ values }: { values: string[] }) => {
    embedCalls++;
    if (fail) throw new Error("provider unreachable");
    return { embeddings: values.map(model), usage: { tokens: 1 } };
  });
}

async function chunkRows(engine: unknown): Promise<Array<{ model: string; nul: boolean }>> {
  const r = await (engine as Db).db.query("SELECT model, embedding IS NULL AS nul FROM content_chunks ORDER BY id");
  return r.rows as Array<{ model: string; nul: boolean }>;
}

const PAGE = "---\ntype: note\n---\n# Note\n\nsome body text for one chunk";

/** A brain embedded with MODEL_A under the openai config, whose record then names `record`. */
async function brainRecordedAs(record: string): Promise<void> {
  await configure();
  await stubTransport(MODEL_A);
  const e = (await getBrain()) as unknown as TestEngine;
  await runAdminOp("put_page", { slug: "notes/seed", content: PAGE });
  await e.setConfig("embedding_model", record);
  await closeBrain();
  await configure();
}

/** Boot, then wait for the background embedding probe (the boot itself does not). */
async function bootSettled(): Promise<unknown> {
  const e = await getBrain();
  await embeddingProbeSettled();
  return e;
}

function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const spies = [spyOn(console, "log"), spyOn(console, "warn"), spyOn(console, "error")].map((s) => s.mockImplementation(() => {}));
  return fn().finally(() => spies.forEach((s) => s.mockRestore()));
}

function logged(spy: { mock: { calls: unknown[][] } }, text: string): boolean {
  return spy.mock.calls.some((c) => c.map(String).join(" ").includes(text));
}

describe("classifyEmbeddingRecord", () => {
  const base = { configured: OPENAI, configuredDims: DIMS, stored: OPENAI, storedDims: DIMS, gateway: OPENAI };
  test("ok when everything agrees, or nothing is configured, or nothing is recorded", () => {
    expect(classifyEmbeddingRecord(base)).toEqual({ kind: "ok" });
    expect(classifyEmbeddingRecord({ ...base, configured: null, stored: DEFAULT_LABEL })).toEqual({ kind: "ok" });
    expect(classifyEmbeddingRecord({ ...base, stored: null, storedDims: null, gateway: null })).toEqual({ kind: "ok" });
    expect(classifyEmbeddingRecord({ ...base, stored: "text-embedding-3-small" })).toEqual({ kind: "ok" });
  });
  test("a provider prefix change with the same name and dimensions is adopted", () => {
    expect(classifyEmbeddingRecord({ ...base, stored: "litellm:text-embedding-3-small" })).toEqual({
      kind: "adopt", from: "litellm:text-embedding-3-small", to: OPENAI,
    });
    expect(bareEmbeddingModel("plain")).toBe("plain");
  });
  test("another model name asks for a probe (the seeded-default brain)", () => {
    expect(classifyEmbeddingRecord({ ...base, stored: DEFAULT_LABEL })).toEqual({ kind: "probe", from: DEFAULT_LABEL, to: OPENAI });
  });
  test("other dimensions or a gateway on another model refuse", () => {
    expect(classifyEmbeddingRecord({ ...base, storedDims: 1536 })).toMatchObject({ kind: "refuse", message: expect.stringContaining("embedding_dimensions is 1536") });
    expect(classifyEmbeddingRecord({ ...base, gateway: DEFAULT_LABEL })).toMatchObject({ kind: "refuse", message: expect.stringContaining("gateway model") });
  });
  test("normalize reads a bare name as openai", () => {
    expect(normalizeEmbeddingModel("text-embedding-3-small")).toBe(OPENAI);
    expect(normalizeEmbeddingModel("  ")).toBeNull();
  });
});

describe("probeEmbeddingRecord", () => {
  type P = { slug: string; title?: string | null; updated: number; chunks: Array<{ text: string; vec: number[] | null; model?: string | null }> };
  /** Pages per source; listPages honours the three sorts the probe asks for. */
  function engine(sources: Record<string, P[]>, calls: string[] = []): ProbeEngine {
    return {
      async listAllSources() {
        return Object.keys(sources).map((id) => ({ id }));
      },
      async listPages({ sourceId, sort, limit }) {
        calls.push(`${sourceId}:${sort}`);
        const ps = [...sources[sourceId]!];
        if (sort === "slug") ps.sort((a, b) => a.slug.localeCompare(b.slug));
        if (sort === "updated_asc") ps.sort((a, b) => a.updated - b.updated);
        if (sort === "updated_desc") ps.sort((a, b) => b.updated - a.updated);
        return ps.slice(0, limit);
      },
      async getChunksWithEmbeddings(slug, { sourceId }) {
        const p = sources[sourceId]!.find((x) => x.slug === slug)!;
        return p.chunks.map((c) => ({ chunk_text: c.text, chunk_source: "compiled_truth", embedding: c.vec, model: c.model ?? DEFAULT_LABEL }));
      },
    };
  }
  const page = (slug: string, updated: number, model: (t: string) => number[], n = 2): P => ({
    slug, updated, title: "T", chunks: Array.from({ length: n }, (_, i) => ({ text: `${slug} ${i}`, vec: model(`${slug} ${i}`) })),
  });
  const embedA = async (t: string[]) => t.map(MODEL_A);

  test("a uniform brain matches; at most one chunk per page; every source and sort is sampled", async () => {
    const calls: string[] = [];
    const sent: string[] = [];
    const r = await probeEmbeddingRecord(
      engine({ s1: [page("a", 1, MODEL_A), page("b", 2, MODEL_A), page("c", 3, MODEL_A)], s2: [page("d", 1, MODEL_A)] }, calls),
      { embed: async (t) => (sent.push(...t), embedA(t)), defaultLabel: DEFAULT_LABEL },
    );
    expect(r).toMatchObject({ status: "match", samples: 4, min: expect.any(Number) });
    expect(sent.sort()).toEqual(["a 0", "b 0", "c 0", "d 0"]);
    expect(calls).toEqual(["s1:updated_asc", "s1:updated_desc", "s1:slug", "s2:updated_asc", "s2:updated_desc", "s2:slug"]);
  });

  test("a mixed brain (older pages on another model) is a mismatch even when the slug-first page matches", async () => {
    // Slug order alone would sample only "a-new" (and its chunks) and adopt.
    const r = await probeEmbeddingRecord(
      engine({ s1: [page("a-new", 9, MODEL_A, 5), page("m-old", 1, MODEL_B), page("z-old", 2, MODEL_B)] }),
      { embed: embedA, samples: 5 },
    );
    expect(r.status).toBe("mismatch");
  });

  test("the title-wrapped input counts as a match", async () => {
    const p: P = { slug: "w", updated: 1, title: "T", chunks: [{ text: "x", vec: MODEL_A("<T>x") }] };
    const r = await probeEmbeddingRecord(engine({ s: [p] }), { embed: embedA, wrap: (title, text) => `<${title}>${text}` });
    expect(r).toMatchObject({ status: "match", samples: 1 });
  });

  test("labels naming two models other than the default are mixed, never adopted", async () => {
    const p1: P = { slug: "a", updated: 1, chunks: [{ text: "a", vec: MODEL_A("a"), model: OPENAI }] };
    const p2: P = { slug: "b", updated: 2, chunks: [{ text: "b", vec: MODEL_A("b"), model: "voyage:voyage-3" }, { text: "c", vec: null, model: "google:x" }] };
    const r = await probeEmbeddingRecord(engine({ s: [p1, p2] }), { embed: embedA, defaultLabel: DEFAULT_LABEL });
    expect(r).toEqual({ status: "mixed", labels: [OPENAI, "voyage:voyage-3"] });
    const one = await probeEmbeddingRecord(engine({ s: [p1] }), { embed: embedA, defaultLabel: DEFAULT_LABEL });
    expect(one.status).toBe("match");
  });

  test("no stored vectors is empty; maxPages bounds the walk", async () => {
    const empty: P = { slug: "e", updated: 1, chunks: [{ text: "e", vec: null }] };
    expect(await probeEmbeddingRecord(engine({ s: [empty, page("f", 2, MODEL_A)] }), { embed: embedA, maxPages: 1 })).toEqual({ status: "empty", samples: 0 });
  });

  test("an embed error or a timeout is an error, never a verdict", async () => {
    const e = engine({ s: [page("a", 1, MODEL_A)] });
    expect(await probeEmbeddingRecord(e, { embed: async () => { throw new Error("down"); } })).toEqual({ status: "error", error: "down" });
    const slow = await probeEmbeddingRecord(e, { embed: () => new Promise(() => {}), timeoutMs: 20 });
    expect(slow).toMatchObject({ status: "error", error: expect.stringContaining("timed out") });
  });

  test("cosine edge cases", () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 2], [2, 4])).toBeCloseTo(1, 9);
  });
});

describe("installChunkModelStamp", () => {
  function fakeEngine() {
    const seen: Array<{ chunks: Array<Record<string, unknown>>; opts: unknown }> = [];
    const engine = {
      async upsertChunks(_slug: string, chunks: Array<Record<string, unknown>>, opts?: unknown) {
        seen.push({ chunks, opts });
      },
    };
    return { engine, seen };
  }

  test("a vector is gateway-made unless carried in: its explicit label is replaced by the gateway's model", async () => {
    const { engine, seen } = fakeEngine();
    installChunkModelStamp(engine, { labelModel: () => OPENAI, gatewayModel: () => OPENAI });
    installChunkModelStamp(engine, { labelModel: () => "x:y", gatewayModel: () => "x:y" }); // idempotent
    await engine.upsertChunks("a", [
      { chunk_index: 0, embedding: [1], model: DEFAULT_LABEL },
      { chunk_index: 1 },
      { chunk_index: 2, model: "voyage:voyage-3" },
      { chunk_index: 3, modality: "image", model: "voyage:voyage-multimodal-3" },
    ], { sourceId: "s" });
    expect(seen[0]!.chunks.map((c) => c.model)).toEqual([OPENAI, OPENAI, OPENAI, "voyage:voyage-multimodal-3"]);
    expect(seen[0]!.chunks[0]!.embedding).toEqual([1]);
    expect(seen[0]!.opts).toEqual({ sourceId: "s" });
  });

  test("carried-in chunks keep their labels; the flag never reaches gbrain", async () => {
    const { engine, seen } = fakeEngine();
    installChunkModelStamp(engine, { labelModel: () => OPENAI, gatewayModel: () => null });
    await engine.upsertChunks("c", [{ chunk_index: 0, embedding: [1], model: "voyage:voyage-3" }, { chunk_index: 1, embedding: [1] }], { sourceId: "s", [CARRIED_IN]: true });
    expect(seen[0]!.chunks).toEqual([
      { chunk_index: 0, embedding: [1], model: "voyage:voyage-3" },
      { chunk_index: 1, embedding: [1], model: OPENAI },
    ]);
    expect(seen[0]!.opts).toEqual({ sourceId: "s" });
  });

  test("a vector the gateway made with another model (or with no gateway) is dropped, loudly", async () => {
    const { engine, seen } = fakeEngine();
    const refused: string[] = [];
    installChunkModelStamp(engine, { labelModel: () => OPENAI, gatewayModel: () => DEFAULT_LABEL, onRefuse: (m) => refused.push(m) });
    await engine.upsertChunks("a", [{ chunk_index: 0, embedding: [1] }]);
    expect(seen[0]!.chunks[0]).toEqual({ chunk_index: 0, model: OPENAI });
    expect(refused[0]).toContain(`gateway model ${DEFAULT_LABEL}`);

    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const f = fakeEngine();
      installChunkModelStamp(f.engine, { labelModel: () => OPENAI, gatewayModel: () => null });
      await f.engine.upsertChunks("b", [{ chunk_index: 0, embedding: [1] }], { [CARRIED_IN]: false });
      expect(f.seen[0]!.chunks[0]!.embedding).toBeUndefined();
      expect(logged(err, "gateway model (none)")).toBe(true);
    } finally {
      err.mockRestore();
    }
  });

  test("passes through when there is no label model, and skips a non-engine", async () => {
    const { engine, seen } = fakeEngine();
    installChunkModelStamp(engine, { labelModel: () => null, gatewayModel: () => null });
    await engine.upsertChunks("a", [{ chunk_index: 0, embedding: [1] }]);
    expect(seen[0]!.chunks[0]).toEqual({ chunk_index: 0, embedding: [1] });
    expect(() => installChunkModelStamp({}, { labelModel: () => null, gatewayModel: () => null })).not.toThrow();
  });
});

describe("brain boot: writes use the configured embedding model", () => {
  test("put_page embeds with the configured provider and labels the chunk with it", async () => {
    await configure();
    await stubTransport();
    await getBrain();
    expect(embeddingActive()).toBe(true);
    expect(configuredEmbeddingModel()).toBe(OPENAI);
    await runAdminOp("put_page", { slug: "notes/one", content: PAGE });
    expect(embedCalls).toBeGreaterThan(0);
    const rows = await chunkRows(await getBrain());
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).toEqual({ model: OPENAI, nul: false });
  }, 60_000);

  test("seeded-default brain: the record names gbrain's default, the vectors are the configured model: probe adopts", async () => {
    await brainRecordedAs(DEFAULT_LABEL);
    await stubTransport(MODEL_A);
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const e = (await bootSettled()) as unknown as TestEngine;
      expect(logged(log, `[brain] embedding record adopted: ${DEFAULT_LABEL} -> ${OPENAI} (probe ok: 1 sample(s), min cosine 1.0000)`)).toBe(true);
      expect(embeddingActive()).toBe(true);
      expect(embeddingRefusal()).toBeNull();
      expect(await e.getConfig("embedding_model")).toBe(OPENAI);
    } finally {
      log.mockRestore();
    }
  }, 60_000);

  test("prefix-only change (litellm:x vs openai:x) adopts without probing", async () => {
    await brainRecordedAs("litellm:text-embedding-3-small");
    await stubTransport(MODEL_A, true); // a probe would fail; none must run
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const e = (await getBrain()) as unknown as TestEngine;
      expect(embedCalls).toBe(0);
      expect(logged(log, "(provider prefix only)")).toBe(true);
      expect(embeddingActive()).toBe(true);
      expect(await e.getConfig("embedding_model")).toBe(OPENAI);
    } finally {
      log.mockRestore();
    }
  }, 60_000);

  test("a brain with no stored vectors adopts", async () => {
    await configure();
    const e0 = (await getBrain()) as unknown as TestEngine;
    await e0.setConfig("embedding_model", DEFAULT_LABEL);
    await closeBrain();
    await configure();
    await stubTransport(MODEL_A);
    const e = (await quiet(() => bootSettled())) as unknown as TestEngine;
    expect(embeddingActive()).toBe(true);
    expect(await e.getConfig("embedding_model")).toBe(OPENAI);
  }, 60_000);

  test("the boot does not wait for the probe, and closeBrain does not wait for it either", async () => {
    await brainRecordedAs(DEFAULT_LABEL);
    const gw = (await gbrainImport("ai/gateway")) as Gw;
    gw.__setEmbedTransportForTests(() => new Promise(() => {})); // a provider that never answers
    const t0 = Date.now();
    const e = (await getBrain()) as unknown as TestEngine;
    expect(embeddingActive()).toBe(true); // embedding stays on while the probe runs
    expect(await e.getConfig("embedding_model")).toBe(DEFAULT_LABEL);
    await closeBrain();
    expect(Date.now() - t0).toBeLessThan(15_000);
    await embeddingProbeSettled(); // nothing in flight after a close
  }, 60_000);

  test("a probe error keeps embedding on and warns, the record unchanged", async () => {
    await brainRecordedAs(DEFAULT_LABEL);
    await stubTransport(MODEL_A, true);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const e = (await bootSettled()) as unknown as TestEngine;
      expect(logged(warn, "the probe of stored vectors failed")).toBe(true);
      expect(embeddingActive()).toBe(true);
      expect(embeddingRefusal()).toBeNull();
      expect(await e.getConfig("embedding_model")).toBe(DEFAULT_LABEL);
    } finally {
      warn.mockRestore();
    }
  }, 60_000);

  test("a mixed brain (older page on another same-width model) is not adopted, even when the slug-first page matches", async () => {
    await configure();
    await stubTransport(MODEL_B);
    const e0 = (await getBrain()) as unknown as TestEngine;
    await runAdminOp("put_page", { slug: "notes/z-old", content: "---\ntype: note\n---\n# Old\n\nolder body" });
    await stubTransport(MODEL_A);
    await new Promise((r) => setTimeout(r, 20));
    await runAdminOp("put_page", { slug: "notes/a-new", content: "---\ntype: note\n---\n# New\n\nnewer body" });
    await e0.setConfig("embedding_model", DEFAULT_LABEL);
    await closeBrain();
    await configure();
    await stubTransport(MODEL_A);
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const e = (await bootSettled()) as unknown as TestEngine;
      expect(logged(err, "EMBEDDING REFUSED")).toBe(true);
      expect(embeddingActive()).toBe(false);
      expect(await e.getConfig("embedding_model")).toBe(DEFAULT_LABEL);
    } finally {
      err.mockRestore();
    }
  }, 60_000);

  test("chunk labels naming two models refuse auto-adoption", async () => {
    await configure();
    await stubTransport(MODEL_A);
    const e0 = (await getBrain()) as unknown as TestEngine;
    await runAdminOp("put_page", { slug: "notes/one", content: PAGE });
    await runAdminOp("put_page", { slug: "notes/two", content: "---\ntype: note\n---\n# Two\n\nanother body" });
    const vec = new Float32Array(MODEL_A("another body"));
    await e0.upsertChunks("notes/two", [{ chunk_index: 0, chunk_text: "another body", chunk_source: "compiled_truth", embedding: vec, model: "voyage:voyage-3" }], { sourceId: "default", [CARRIED_IN]: true });
    await e0.setConfig("embedding_model", DEFAULT_LABEL);
    await closeBrain();
    await configure();
    await stubTransport(MODEL_A);
    await quiet(async () => {
      await bootSettled();
      expect(embeddingRefusal()).toContain("a mixed brain is never adopted automatically");
    });
  }, 60_000);

  test("stored vectors of another model refuse; writes land unembedded, labelled with the brain's record", async () => {
    await brainRecordedAs(DEFAULT_LABEL);
    await stubTransport(MODEL_B);
    const err = spyOn(console, "error").mockImplementation(() => {});
    let engine: unknown;
    try {
      engine = await bootSettled();
      expect(logged(err, "EMBEDDING REFUSED")).toBe(true);
    } finally {
      err.mockRestore();
    }
    expect(embeddingActive()).toBe(false);
    expect(embeddingRefusal()).toContain("stored vectors do not match");
    await runAdminOp("put_page", { slug: "notes/two", content: "---\ntype: note\n---\n# Two\n\nanother body" });
    const rows = await (engine as Db).db.query(
      "SELECT cc.model, cc.embedding IS NULL AS nul FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE p.slug = 'notes/two'",
    );
    for (const r of rows.rows) expect(r).toEqual({ model: DEFAULT_LABEL, nul: true });
  }, 60_000);

  test("a process with no embedding config labels writes with the brain's own record", async () => {
    await configure();
    await getBrain();
    await closeBrain();
    for (const k of ["EMBEDDING_PROVIDER", "EMBEDDING_MODEL", "EMBEDDING_DIMENSIONS", "EMBEDDING_API_KEY", "OPENAI_API_KEY"]) delete process.env[k];
    await quiet(async () => {
      const engine = await getBrain();
      expect(embeddingActive()).toBe(false);
      await runAdminOp("put_page", { slug: "notes/three", content: PAGE });
      for (const r of await chunkRows(engine)) expect(r).toEqual({ model: OPENAI, nul: true });
      await expect(runReembedCommand({ apply: true })).rejects.toThrow("embedding gateway inactive");
    });
  }, 60_000);

  test("a transaction engine inherits the stamp: carried labels kept, gateway vectors relabelled (getChunks round trip)", async () => {
    await configure();
    await stubTransport();
    const engine = (await getBrain()) as unknown as TestEngine;
    await runAdminOp("put_page", { slug: "notes/tx", content: PAGE });
    const vec = new Float32Array(MODEL_A("x"));
    const chunk = { chunk_index: 0, chunk_text: "some body text for one chunk", chunk_source: "compiled_truth", embedding: vec };
    await engine.transaction((tx) => tx.upsertChunks("notes/tx", [{ ...chunk, model: "voyage:voyage-3" }], { sourceId: "default", [CARRIED_IN]: true }));
    expect((await engine.getChunks("notes/tx", { sourceId: "default" }))[0]!.model).toBe("voyage:voyage-3");
    await engine.transaction((tx) => tx.upsertChunks("notes/tx", [{ ...chunk, model: "voyage:voyage-3" }], { sourceId: "default" }));
    expect((await engine.getChunks("notes/tx", { sourceId: "default" }))[0]!.model).toBe(OPENAI);
  }, 60_000);
});

describe("slaude brain reembed", () => {
  test("--model-mismatch: dry run reports, apply re-embeds and relabels", async () => {
    await configure();
    await stubTransport();
    const engine = (await getBrain()) as unknown as TestEngine;
    await runAdminOp("put_page", { slug: "notes/good", content: PAGE });
    await runAdminOp("put_page", { slug: "notes/bad", content: PAGE });
    // A chunk labelled with gbrain's default, as gbrain wrote it before the stamp.
    await engine.upsertChunks("notes/bad", [{ chunk_index: 0, chunk_text: "some body text for one chunk", chunk_source: "compiled_truth", model: DEFAULT_LABEL }], { sourceId: "default", [CARRIED_IN]: true });

    const dry = await quiet(() => runReembedCommand({ apply: false }));
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

  test("--adopt records the configured model only with --apply, touching no vector", async () => {
    await brainRecordedAs(DEFAULT_LABEL);
    await stubTransport(MODEL_B); // realign mode: the boot neither probes nor refuses
    await quiet(async () => {
      const dry = await runAdoptCommand({ apply: false });
      expect(dry).toEqual({ apply: false, from: DEFAULT_LABEL, to: OPENAI, changed: true });
      expect(formatAdoptReport(dry)).toContain("dry run: nothing changed");
      expect(embedCalls).toBe(0);
      const engine = (await getBrain()) as unknown as TestEngine;
      expect(await engine.getConfig("embedding_model")).toBe(DEFAULT_LABEL);
      const done = await runAdoptCommand({ apply: true });
      expect(formatAdoptReport(done)).toBe(`brain record adopted: ${DEFAULT_LABEL} -> ${OPENAI}`);
      expect(await engine.getConfig("embedding_model")).toBe(OPENAI);
      expect(formatAdoptReport(await runAdoptCommand({ apply: true }))).toContain("nothing to adopt");
      expect(embedCalls).toBe(0);
    });
  }, 60_000);

  test("refuses without a configured model, and in remote mode", async () => {
    home = await newHome(false);
    process.env.SLAUDE_BRAIN_HOME = home;
    await expect(runReembedCommand({ apply: false })).rejects.toThrow("no embedding model configured");
    await closeBrain();
    process.env.SLAUDE_BRAIN_MODE = "remote";
    await expect(runReembedCommand({ apply: false })).rejects.toThrow("SLAUDE_BRAIN_MODE=remote");
  }, 60_000);

  test("the vector column width is the dimension authority: a config row alone does not refuse, the column does", async () => {
    await configure();
    const engine = (await getBrain()) as unknown as TestEngine;
    await engine.setConfig("embedding_dimensions", "1536");
    await closeBrain();
    await configure();
    await quiet(async () => {
      await getBrain();
      expect(embeddingRefusal()).toBeNull();
      await closeBrain();
      // config.json already says 1536, so the boot keeps the 1280-wide store
      // and this process now asks for 1536 against a 1280 column.
      for (const f of [join(home!, "config.json"), join(home!, ".gbrain", "config.json")]) {
        const cfg = JSON.parse(readFileSync(f, "utf8"));
        writeFileSync(f, JSON.stringify({ ...cfg, embedding_dimensions: 1536 }));
      }
      await configure();
      process.env.EMBEDDING_DIMENSIONS = "1536";
      await getBrain();
      expect(embeddingRefusal()).toContain(`embedding_dimensions is ${DIMS} but this process is configured for 1536`);
      await closeBrain();
      process.env.EMBEDDING_DIMENSIONS = "1536";
      await expect(runAdoptCommand({ apply: true })).rejects.toThrow("can change the vector column width");
    });
  }, 60_000);
});

describe("reembedModelMismatch core", () => {
  type Row = { chunk_index: number; chunk_text: string; chunk_source: string; model: string | null; token_count?: number | null };
  function memEngine(o: { record: string | null; pages?: Record<string, Row[]>; signatures?: Record<string, string>; images?: Record<string, number[]> }) {
    const config = new Map<string, string>(o.record ? [["embedding_model", o.record]] : []);
    const chunks = new Map<string, Row[]>(Object.entries(o.pages ?? {
      a: [{ chunk_index: 0, chunk_text: "x", chunk_source: "compiled_truth", model: OPENAI }],
      b: [{ chunk_index: 0, chunk_text: "y", chunk_source: "compiled_truth", model: OPENAI }],
    }));
    const writes: Array<{ slug: string; chunks: Array<Record<string, unknown>> }> = [];
    const signatures = new Map(Object.entries(o.signatures ?? {}));
    let changeOnRead: string | null = null;
    const engine: ReembedEngine & { changeNext(slug: string): void } = {
      changeNext(slug) {
        changeOnRead = slug;
      },
      async listPages({ offset, includeDeleted }) {
        expect(includeDeleted).toBe(true);
        return offset === 0 ? [...chunks.keys()].map((slug) => ({ slug })) : [];
      },
      async getChunks(slug) {
        return chunks.get(slug) ?? [];
      },
      async upsertChunks(slug, cs) {
        if (slug === "b" && config.get("fail") === "1") throw new Error("boom");
        writes.push({ slug, chunks: cs as Array<Record<string, unknown>> });
        chunks.set(slug, (cs as Row[]).map((c) => ({ ...c })));
      },
      async setPageEmbeddingSignature(slug, { signature }) {
        signatures.set(slug, signature);
      },
      async getConfig(k) {
        return config.get(k) ?? null;
      },
      async setConfig(k, v) {
        config.set(k, v);
      },
      async transaction(fn) {
        if (changeOnRead) {
          const slug = changeOnRead;
          changeOnRead = null;
          const tx = { ...engine, getChunks: async () => [{ chunk_index: 0, chunk_text: "edited", chunk_source: "compiled_truth", model: OPENAI }] };
          return fn(tx as ReembedEngine).finally(() => void slug);
        }
        return fn(engine);
      },
      async executeRaw<T>(_sql: string, params?: unknown[]) {
        const slug = String(params?.[0]);
        const sig = signatures.get(slug) ?? null;
        const imgs = o.images?.[slug] ?? [];
        return (chunks.get(slug) ?? []).map((c) => ({ sig, idx: c.chunk_index, modality: imgs.includes(c.chunk_index) ? "image" : "text" })) as T[];
      },
    };
    return { engine, config, writes, signatures };
  }
  const SIG = `${OPENAI}:${DIMS}`;
  const deps = (engine: ReembedEngine) => ({
    engine, target: OPENAI, targetDims: DIMS, sourceIds: ["default"],
    embed: async (t: string[]) => t.map(() => new Float32Array(DIMS)), signature: () => SIG,
  });

  test("a brain recorded with another model is re-embedded whole, then recorded as the configured one", async () => {
    const { engine, config } = memEngine({ record: DEFAULT_LABEL });
    expect((await reembedModelMismatch(deps(engine), false)).pagesMismatched).toBe(2);
    const r = await reembedModelMismatch(deps(engine), true);
    expect(r.brainModelUpdated).toBe(true);
    expect(config.get("embedding_model")).toBe(OPENAI);
    expect(config.get("embedding_dimensions")).toBe(String(DIMS));
    expect(formatReembedReport(r)).toContain(`brain record set to ${OPENAI}`);
  });

  test("a whole-brain run resumes: pages already on the target label and signature are skipped", async () => {
    const { engine, writes } = memEngine({ record: DEFAULT_LABEL, signatures: { a: SIG } });
    const r = await reembedModelMismatch(deps(engine), true);
    expect(r.pagesCurrent).toBe(1);
    expect(writes.map((w) => w.slug)).toEqual(["b"]);
  });

  test("a page changed between the embed call and the write is skipped, and the record is not set", async () => {
    const { engine, config, writes } = memEngine({ record: DEFAULT_LABEL });
    engine.changeNext("a");
    const r = await reembedModelMismatch(deps(engine), true);
    expect(r.pagesChanged).toBe(1);
    expect(writes.map((w) => w.slug)).toEqual(["b"]);
    expect(r.brainModelUpdated).toBe(false);
    expect(config.get("embedding_model")).toBe(DEFAULT_LABEL);
    expect(formatReembedReport(r)).toContain("skipped 1 page(s) changed during the run");
  });

  test("keeps modality and token_count; image chunks get no text vector", async () => {
    const { engine, writes } = memEngine({
      record: OPENAI,
      pages: { m: [
        { chunk_index: 0, chunk_text: "t", chunk_source: "compiled_truth", model: DEFAULT_LABEL, token_count: 42 },
        { chunk_index: 1, chunk_text: "img", chunk_source: "compiled_truth", model: "voyage:voyage-multimodal-3", token_count: null },
      ] },
      images: { m: [1] },
    });
    const r = await reembedModelMismatch(deps(engine), true);
    expect(r.chunksMismatched).toBe(1);
    const [text, image] = writes[0]!.chunks;
    expect(text).toMatchObject({ modality: "text", token_count: 42, model: OPENAI });
    expect(text!.embedding).toBeInstanceOf(Float32Array);
    expect(image).toMatchObject({ modality: "image", model: "voyage:voyage-multimodal-3", token_count: 1 });
    expect(image!.embedding).toBeUndefined();
  });

  test("pages with only image chunks, or none, are left alone", async () => {
    const { engine, writes } = memEngine({ record: OPENAI, pages: { e: [], i: [{ chunk_index: 0, chunk_text: "i", chunk_source: "compiled_truth", model: null }] }, images: { i: [0] } });
    const r = await reembedModelMismatch(deps(engine), true);
    expect(r.pagesMismatched).toBe(0);
    expect(writes).toEqual([]);
  });

  test("a failed page is reported and the brain record is left alone", async () => {
    const { engine, config } = memEngine({ record: DEFAULT_LABEL });
    config.set("fail", "1");
    const r = await reembedModelMismatch(deps(engine), true);
    expect(r.errors.map((e) => e.slug)).toEqual(["b"]);
    expect(r.brainModelUpdated).toBe(false);
    expect(formatReembedReport(r)).toContain("FAILED default/b: boom");
  });

  test("the report keeps counts and only the first pages", async () => {
    const pages: Record<string, Row[]> = {};
    for (let i = 0; i < REPORT_PAGE_LIMIT + 2; i++) pages[`p${i}`] = [{ chunk_index: 0, chunk_text: "x", chunk_source: "compiled_truth", model: DEFAULT_LABEL }];
    const r = await reembedModelMismatch(deps(memEngine({ record: OPENAI, pages }).engine), false);
    expect(r.pagesMismatched).toBe(REPORT_PAGE_LIMIT + 2);
    expect(r.pages.length).toBe(REPORT_PAGE_LIMIT);
    expect(formatReembedReport(r)).toContain("... 2 more");
  });
});

describe("bundle import labels", () => {
  function fakeMigrateEngine() {
    const upserts: Array<{ chunks: Array<Record<string, unknown>>; opts: Record<string, unknown> | undefined }> = [];
    const engine = {
      async getPage() {
        return null;
      },
      async transaction<T>(fn: (tx: unknown) => Promise<T>) {
        return fn(engine);
      },
      async putPage() {},
      async upsertChunks(_s: string, chunks: Array<Record<string, unknown>>, opts?: Record<string, unknown>) {
        upserts.push({ chunks, opts });
      },
      async addTag() {},
      async addTimelineEntry() {},
      async putRawData() {},
    };
    return { engine: engine as unknown as MigrateEngine, upserts };
  }
  const page: BundlePage = {
    source: "shared", slug: "x", type: "note", title: "x", compiledTruth: "x", timeline: "", frontmatter: {}, contentHash: null,
    chunks: [
      { index: 0, text: "x", source: "compiled_truth", embedding: [1, 2], model: DEFAULT_LABEL, tokens: 1 },
      { index: 1, text: "y", source: "compiled_truth", embedding: null, model: null, tokens: null },
    ],
    tags: [], timelineEntries: [], raw: [], links: [],
  };
  const opts = { onConflict: "skip" as const, dryRun: false, ensureSource: async () => {}, deferLinks: true };

  test("same model on both sides: carried vectors are relabelled with it; the call is marked carried in", async () => {
    const { engine, upserts } = fakeMigrateEngine();
    await applyPage(engine, { page, target: "shared", linkTargets: [] }, { ...opts, relabelModel: OPENAI });
    expect(upserts[0]!.chunks.map((c) => c.model)).toEqual([OPENAI, undefined]);
    expect(upserts[0]!.opts).toEqual({ sourceId: "shared", [CARRIED_IN]: true });
  });

  test("without a shared model the bundle's own labels travel", async () => {
    const { engine, upserts } = fakeMigrateEngine();
    await applyPage(engine, { page, target: "shared", linkTargets: [] }, opts);
    expect(upserts[0]!.chunks.map((c) => c.model)).toEqual([DEFAULT_LABEL, undefined]);
  });
});
