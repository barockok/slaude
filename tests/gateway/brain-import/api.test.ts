// tests/gateway/brain-import/api.test.ts
import { describe, expect, test } from "bun:test";
import { createBrainImportApi, type BrainImportDeps } from "../../../src/gateway/brain-import/api";
import type { BundlePage } from "../../../src/brain-migrate/bundle";
import type { MigrateEngine } from "../../../src/brain-migrate/engine-types";

const TOKEN = "t".repeat(40);
const URLP = (p = "ana") => `https://gw.example.com/brain-import/v1/personas/${p}`;
const pg = (source: string, slug: string, truth = "body " + slug): BundlePage => ({
  source, slug, type: "note", title: slug, compiledTruth: truth, timeline: "", frontmatter: {}, contentHash: null,
  chunks: [{ index: 0, text: truth, source: "compiled_truth", embedding: [0.1, 0.2], model: "m", tokens: 1 }],
  tags: [], timelineEntries: [], raw: [], links: [],
});
const body = (pages: BundlePage[], over: Record<string, unknown> = {}) => ({
  engine: { embeddingModel: "m", embeddingDimensions: 2 }, pages, ...over,
});
const post = (b: unknown, token: string | null = TOKEN, path = URLP()) =>
  new Request(path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(b) });

function fakeEngine() {
  const pages = new Map<string, number>();
  const writes: string[] = [];
  const e = {
    getPage: async (slug: string, o: any) => (pages.has(`${o.sourceId}/${slug}`) ? { slug } : null),
    transaction: async (fn: any) => fn(e),
    db: { query: async () => ({ rows: [] }) }, executeRaw: async () => [],
    putPage: async (slug: string, _p: any, o: any) => { pages.set(`${o.sourceId}/${slug}`, 1); writes.push(`${o.sourceId}/${slug}`); },
    upsertChunks: async () => {}, addTag: async () => {}, addTimelineEntry: async () => {}, putRawData: async () => {}, addLink: async () => {},
  };
  return { e: e as unknown as MigrateEngine, writes };
}
function api(over: Partial<BrainImportDeps> = {}) {
  const f = fakeEngine();
  const lines: string[] = [];
  return {
    ...f, lines,
    api: createBrainImportApi({
      env: () => ({ SLAUDE_BRAIN_IMPORT_TOKEN: TOKEN }),
      engine: async () => f.e,
      brainConfig: () => ({ embeddingModel: "m", embeddingDimensions: 2 }),
      resolveAgentId: async (n) => (n === "ana" ? "UANA-1x" : n === "default" ? "UBOTDEF" : null),
      ensureSource: async () => {},
      brainOn: () => ({ enabled: true, mode: "local" }),
      log: (l) => lines.push(l),
      ...over,
    }),
  };
}
const call = async (a: ReturnType<typeof api>, req: Request) => { const r = await a.api.fetch(req); return { status: r!.status, json: await r!.json() as any }; };

describe("auth and mount", () => {
  test("another prefix is not ours", async () => {
    expect(await api().api.fetch(new Request("https://gw/v1/x"))).toBeNull();
  });
  test("unset token: every method and path 404s, before anything else", async () => {
    const a = api({ env: () => ({}) });
    for (const [m, p] of [["POST", URLP()], ["GET", URLP()], ["POST", "https://gw/brain-import/x"]] as const) {
      expect((await call(a, new Request(p, { method: m }))).status).toBe(404);
    }
  });
  test("wrong or missing token is 401; a token of the wrong length is 401", async () => {
    const a = api();
    expect((await call(a, post(body([]), "x".repeat(40)))).status).toBe(401);
    expect((await call(a, post(body([]), null))).status).toBe(401);
    expect((await call(a, post(body([]), "short"))).status).toBe(401);
  });
  test("only POST on the persona path; unknown shapes 404", async () => {
    const a = api();
    expect((await call(a, new Request(URLP(), { method: "GET", headers: { authorization: `Bearer ${TOKEN}` } }))).status).toBe(405);
    expect((await call(a, post(body([]), TOKEN, "https://gw/brain-import/v1/nope"))).status).toBe(404);
  });
});

describe("refusals", () => {
  test("brain disabled and remote mode are 409", async () => {
    expect((await call(api({ brainOn: () => ({ enabled: false, mode: "local" }) }), post(body([])))).status).toBe(409);
    expect((await call(api({ brainOn: () => ({ enabled: true, mode: "remote" }) }), post(body([])))).status).toBe(409);
  });
  test("an unknown persona is 409", async () => {
    expect((await call(api(), post(body([]), TOKEN, URLP("ghost")))).status).toBe(409);
  });
  test("embedding mismatch is 409 naming both values; nothing written", async () => {
    const a = api();
    const r = await call(a, post(body([pg("agent-default", "s1")], { engine: { embeddingModel: "m", embeddingDimensions: 4 } })));
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/4/); expect(r.json.error).toMatch(/2/);
    expect(a.writes).toEqual([]);
  });
  test("a null model on both sides passes when dimensions match; a null on one side passes; model differing on both refuses", async () => {
    const n = (model: string | null, dims: number) => ({ engine: { embeddingModel: model, embeddingDimensions: dims } });
    expect((await call(api({ brainConfig: () => ({ embeddingModel: null, embeddingDimensions: 2 }) }), post(body([pg("shared", "a")], n(null, 2))))).status).toBe(200);
    expect((await call(api({ brainConfig: () => ({ embeddingModel: null, embeddingDimensions: 2 }) }), post(body([pg("shared", "a")], n("m", 2))))).status).toBe(200);
    const r = await call(api({ brainConfig: () => ({ embeddingModel: "other", embeddingDimensions: 2 }) }), post(body([pg("shared", "a")], n("m", 2))));
    expect(r.status).toBe(409); expect(r.json.error).toMatch(/'m'/); expect(r.json.error).toMatch(/'other'/);
  });
  test("a bundle with no embeddings skips the model check", async () => {
    const p = { ...pg("agent-default", "s1"), chunks: [{ index: 0, text: "t", source: "compiled_truth" as const, embedding: null, model: null, tokens: null }] };
    const a = api();
    expect((await call(a, post(body([p], { engine: { embeddingModel: null, embeddingDimensions: null } })))).status).toBe(200);
  });
  test("kb-* is 422 and an unmapped source is 422; neither echoes page text", async () => {
    const a = api();
    for (const src of ["kb-bulk-corpus", "scratch"]) {
      const r = await call(a, post(body([pg(src, "s", "TOP-SECRET-TEXT")])));
      expect(r.status).toBe(422);
      expect(JSON.stringify(r.json)).not.toContain("TOP-SECRET-TEXT");
    }
    expect(a.writes).toEqual([]);
  });
  test("a kb-* source is 422 even when the map names it", async () => {
    const a = api();
    expect((await call(a, post(body([pg("kb-bulk-corpus", "s")], { map: { "kb-bulk-corpus": "shared" } })))).status).toBe(422);
    expect(a.writes).toEqual([]);
  });
  test("a token under 32 characters is not configured (404)", async () => {
    const a = api({ env: () => ({ SLAUDE_BRAIN_IMPORT_TOKEN: "t".repeat(31) }) });
    expect((await call(a, post(body([]), "t".repeat(31)))).status).toBe(404);
  });
  test("a map into kb-* is 422", async () => {
    expect((await call(api(), post(body([pg("scratch", "s")], { map: { scratch: "kb-x" } })))).status).toBe(422);
  });
  test("oversize body 413, over 100 pages 422, non-JSON 422", async () => {
    const a = api();
    expect((await call(a, post(body(Array.from({ length: 101 }, (_, i) => pg("shared", "p" + i)))))).status).toBe(422);
    expect((await call(a, new Request(URLP(), { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "not json" }))).status).toBe(422);
    expect((await call(a, post(body([pg("shared", "big", "x".repeat(5 * 1024 * 1024))])))).status).toBe(413);
  });
});

describe("import", () => {
  test("agent-like sources land in the persona's sanitised agent slice; user/shared/public unchanged", async () => {
    const a = api();
    const r = await call(a, post(body([pg("agent-default", "a1"), pg("agent", "a2"), pg("user-ualice", "u1"), pg("shared", "s1"), pg("public", "p1")])));
    expect(r.status).toBe(200);
    expect(r.json.agentSource).toBe("agent-uana1x");
    expect(a.writes.sort()).toEqual(["agent-uana1x/a1", "agent-uana1x/a2", "public/p1", "shared/s1", "user-ualice/u1"]);
    expect(r.json.sources["agent-uana1x"].written).toBe(2);
  });
  test("the default persona maps to the process agent id's slice", async () => {
    const a = api();
    const r = await call(a, post(body([pg("agent-default", "d1")]), TOKEN, URLP("default")));
    expect(r.json.agentSource).toBe("agent-ubotdef");
  });
  test("dryRun writes nothing and reports counts", async () => {
    const a = api();
    const r = await call(a, post(body([pg("agent-default", "a1")], { dryRun: true })));
    expect(r.status).toBe(200);
    expect(r.json.dryRun).toBe(true);
    expect(a.writes).toEqual([]);
    expect(r.json.sources["agent-uana1x"].written).toBe(1);
  });
  test("a re-post under skip skips", async () => {
    const a = api();
    await call(a, post(body([pg("shared", "s1")])));
    const r = await call(a, post(body([pg("shared", "s1")])));
    expect(r.json.sources["shared"].skipped).toBe(1);
  });
  test("failures report counts by reason, with slugs only outside user slices", async () => {
    const a = api({ ensureSource: async () => { throw new Error("SECRET-DETAIL"); } });
    const r = await call(a, post(body([pg("shared", "s1"), pg("user-ualice", "u-slug")])));
    expect(r.status).toBe(200);
    expect(r.json.failedReasons).toEqual({ tx: 2 });
    expect(r.json.failedSlugs).toEqual(["s1"]);
    expect(r.json.sources["shared"].failed).toBe(1);
    expect(JSON.stringify(r.json)).not.toContain("SECRET-DETAIL");
  });
  test("audit line has persona, counts, dryRun, onConflict and no page text or slugs", async () => {
    const a = api();
    await call(a, post(body([pg("agent-default", "private/slug-xyz", "SECRET-BODY")])));
    expect(a.lines).toHaveLength(1);
    expect(a.lines[0]).toMatch(/persona=ana/); expect(a.lines[0]).toMatch(/dryRun=false/); expect(a.lines[0]).toMatch(/onConflict=skip/);
    expect(a.lines[0]).not.toContain("SECRET-BODY"); expect(a.lines[0]).not.toContain("slug-xyz");
  });
});
describe("links", () => {
  const linkEngine = () => {
    const links: Array<{ from: string; toSource: string; toSlug: string }> = [];
    const e: any = {
      getPage: async (slug: string, o: any) => (slug === "k" || o.sourceId === "shared" && slug === "s1" ? { slug } : null),
      transaction: async (fn: any) => fn(e),
      db: { query: async () => ({ rows: [] }) }, executeRaw: async () => [],
      putPage: async () => {}, upsertChunks: async () => {}, addTag: async () => {}, addTimelineEntry: async () => {}, putRawData: async () => {},
      addLink: async (from: string, toSlug: string, _c: string, _t: string, _s: unknown, _a: unknown, _b: unknown, o: any) => { links.push({ from, toSource: o.toSourceId, toSlug }); },
    };
    return { e: e as MigrateEngine, links };
  };
  const lk = (toSource: string, toSlug = "k") => ({ toSource, toSlug, type: "mentions", context: "" });
  test("links into kb-* or an unmapped source are dropped and counted, never written", async () => {
    const f = linkEngine();
    const a = api({ engine: async () => f.e });
    const r = await call(a, post(body([{ ...pg("shared", "src"), links: [lk("kb-x"), lk("scratch")] }])));
    expect(r.status).toBe(200);
    expect(r.json.sources["shared"].linksWritten).toBe(0);
    expect(r.json.sources["shared"].linksDropped).toBe(2);
    expect(f.links).toEqual([]);
  });
  test("a link to an agent-like source lands in the persona's agent slice", async () => {
    const f = linkEngine();
    const a = api({ engine: async () => ({ ...f.e, getPage: async (slug: string) => (slug === "k" ? { slug } : null) } as any) });
    const r = await call(a, post(body([{ ...pg("shared", "src"), links: [lk("agent-default")] }])));
    expect(r.json.sources["shared"].linksDropped).toBe(0);
    expect(f.links.map((l) => l.toSource)).toEqual(["agent-uana1x"]);
  });
  test("a link to a page LATER in the same batch is written, not dropped", async () => {
    const written = new Set<string>();
    const links: string[] = [];
    const e: any = {
      getPage: async (slug: string, o: any) => (written.has(`${o.sourceId}/${slug}`) ? { slug } : null),
      transaction: async (fn: any) => fn(e),
      db: { query: async () => ({ rows: [] }) }, executeRaw: async () => [],
      putPage: async (slug: string, _p: any, o: any) => { written.add(`${o.sourceId}/${slug}`); },
      upsertChunks: async () => {}, addTag: async () => {}, addTimelineEntry: async () => {}, putRawData: async () => {},
      addLink: async (from: string, toSlug: string) => { links.push(`${from}->${toSlug}`); },
    };
    const a = api({ engine: async () => e as MigrateEngine });
    const first = { ...pg("shared", "a-first"), links: [lk("shared", "z-later")] };
    const r = await call(a, post(body([first, pg("shared", "z-later")])));
    expect(r.json.sources["shared"]).toMatchObject({ written: 2, linksWritten: 1, linksDropped: 0, linksFailed: 0 });
    expect(links).toEqual(["a-first->z-later"]);
  });
  test("a dry run writes and counts no links", async () => {
    const f = linkEngine();
    const a = api({ engine: async () => f.e });
    const r = await call(a, post(body([{ ...pg("shared", "src"), links: [lk("shared", "s1")] }], { dryRun: true })));
    expect(r.json.sources["shared"].linksWritten).toBe(0);
    expect(f.links).toEqual([]);
  });
});

describe("body validation", () => {
  test("a 422 names paths and codes, never received values", async () => {
    const p = pg("shared", "s"); (p.chunks[0] as any).source = "SECRET-SLUG-VALUE";
    const r = await call(api(), post({ ...body([p]), "SECRET-KEY": 1 }));
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.json)).not.toContain("SECRET-SLUG-VALUE");
    expect(JSON.stringify(r.json)).not.toContain("SECRET-KEY");
  });
  test("dimensions must be a positive integer and every embedding must match them", async () => {
    const a = api({ brainConfig: () => ({ embeddingModel: "m", embeddingDimensions: 3 }) });
    expect((await call(a, post(body([], { engine: { embeddingModel: null, embeddingDimensions: 0 } })))).status).toBe(422);
    expect((await call(a, post(body([], { engine: { embeddingModel: null, embeddingDimensions: 1.5 } })))).status).toBe(422);
    const r = await call(a, post(body([pg("shared", "s")], { engine: { embeddingModel: "m", embeddingDimensions: 3 } })));
    expect(r.status).toBe(422);
    expect(r.json.error).toMatch(/does not match the declared dimensions/);
    expect(a.writes).toEqual([]);
  });
});

describe("persona path edge cases", () => {
  const at = async (path: string) => (await call(api(), post(body([]), TOKEN, path))).status;
  test("encoded slash, dot segments, uppercase and an empty name are 404", async () => {
    for (const p of ["a%2Fb", "..", "%2e%2e", "Ana", "ANA", ""]) expect(await at(`https://gw.example.com/brain-import/v1/personas/${p}`)).toBe(404);
  });
  test("a trailing slash on a valid persona is accepted (empty segments are ignored)", async () => {
    expect(await at("https://gw.example.com/brain-import/v1/personas/ana/")).toBe(200);
  });
});
