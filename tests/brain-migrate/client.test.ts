import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleWriter, type BundlePage } from "../../src/brain-migrate/bundle";
import { ImportError, hasProblems, runImport } from "../../src/brain-migrate/client";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const page = (source: string, slug: string): BundlePage => ({
  source, slug, type: "note", title: slug, compiledTruth: "t", timeline: "", frontmatter: {}, contentHash: null,
  chunks: [], tags: [], timelineEntries: [], raw: [], links: [],
});
async function bundle(pages: BundlePage[]): Promise<string> {
  const d = mkdtempSync(join(tmpdir(), "cli-")); dirs.push(d);
  const w = new BundleWriter(d); for (const p of pages) await w.writePage(p);
  await w.finish({ engine: { schemaVersion: 1, embeddingModel: null, embeddingDimensions: null }, excluded: [] });
  return d;
}
const base = (b: string, over: Partial<Parameters<typeof runImport>[0]> = {}) => ({ gateway: "https://gw.example.com", persona: "ana", token: "tok", bundle: b, sleep: async () => {}, log: () => {}, ...over });
const zero = { written: 0, skipped: 0, overwritten: 0, failed: 0, linksWritten: 0, linksDropped: 0, linksFailed: 0, linksOutOfScope: 0, noEmbedding: 0 };
const reply = (sources: Record<string, Partial<typeof zero>>, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ persona: "ana", agentSource: "agent-uana", dryRun: false, sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, { ...zero, ...v }])), failedSlugs: [], failedReasons: {}, ...extra }), { status: 200 });
const ok = (counts: Record<string, number>) => reply(Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, { written: n }])));

describe("runImport", () => {
  test("batches at 100 pages, sends the bearer token, aggregates counts, reconciles with the manifest", async () => {
    const pages = Array.from({ length: 250 }, (_, i) => page("agent-default", "p" + i));
    const sent: number[] = []; let auth = "";
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      auth = (init.headers as Record<string, string>).authorization!;
      const n = JSON.parse(init.body as string).pages.length; sent.push(n);
      return ok({ "agent-uana": n });
    }) as unknown as typeof fetch;
    const s = await runImport(base(await bundle(pages), { fetchImpl }));
    expect(sent).toEqual([100, 100, 50]);
    expect(auth).toBe("Bearer tok");
    expect(s.sources["agent-uana"]!.written).toBe(250);
    expect(s.mismatches).toEqual([]);
    expect(hasProblems(s)).toBe(false);
  });
  test("retries a 5xx with backoff and the identical body, then succeeds", async () => {
    let n = 0; const bodies: string[] = []; const waits: number[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => { bodies.push(init.body as string); return ++n < 3 ? new Response("bad", { status: 503 }) : ok({ shared: 1 }); }) as unknown as typeof fetch;
    const s = await runImport(base(await bundle([page("shared", "a")]), { fetchImpl, sleep: async (ms) => { waits.push(ms); } }));
    expect(n).toBe(3);
    expect(new Set(bodies).size).toBe(1);
    expect(waits).toEqual([500, 1000]);
    expect(s.sources.shared!.written).toBe(1);
  });
  test("retries a network error", async () => {
    let n = 0;
    const fetchImpl = (async () => { if (++n < 2) throw new Error("ECONNRESET"); return ok({ shared: 1 }); }) as unknown as typeof fetch;
    const s = await runImport(base(await bundle([page("shared", "a")]), { fetchImpl }));
    expect(n).toBe(2);
    expect(s.sources.shared!.written).toBe(1);
  });
  test("a persistent 5xx gives a clear error after 5 attempts", async () => {
    let n = 0;
    const fetchImpl = (async () => { n++; return new Response("x", { status: 502 }); }) as unknown as typeof fetch;
    await expect(runImport(base(await bundle([page("shared", "a")]), { fetchImpl }))).rejects.toThrow(/unavailable after retries \(502\)/);
    expect(n).toBe(5);
  });
  test("a 4xx stops immediately with the gateway's message", async () => {
    let n = 0;
    const fetchImpl = (async () => { n++; return new Response(JSON.stringify({ error: "embedding mismatch: x" }), { status: 409 }); }) as unknown as typeof fetch;
    await expect(runImport(base(await bundle([page("shared", "a")]), { fetchImpl }))).rejects.toThrow(/embedding mismatch/);
    expect(n).toBe(1);
  });
  test("a corrupted bundle fails before any request", async () => {
    const d = await bundle([page("shared", "a")]);
    const f = join(d, "pages.jsonl");
    await Bun.write(f, (await Bun.file(f).text()).replace('"t"', '"X"'));
    let called = false;
    await expect(runImport(base(d, { fetchImpl: (async () => { called = true; return ok({}); }) as unknown as typeof fetch }))).rejects.toThrow(/checksum/);
    expect(called).toBe(false);
  });
  test("an uncovered source stops the run before any request; a map covers it", async () => {
    const d = await bundle([page("scratch", "a")]);
    let called = false;
    const fetchImpl = (async () => { called = true; return ok({ shared: 1 }); }) as unknown as typeof fetch;
    await expect(runImport(base(d, { fetchImpl }))).rejects.toThrow(/scratch/);
    expect(called).toBe(false);
    const s = await runImport(base(d, { fetchImpl, map: { scratch: "shared" } }));
    expect(s.sources.shared!.written).toBe(1);
  });
  test("a kb-* source is refused even when a map names it", async () => {
    const d = await bundle([page("kb-docs", "a")]);
    let called = false;
    const fetchImpl = (async () => { called = true; return ok({ shared: 1 }); }) as unknown as typeof fetch;
    await expect(runImport(base(d, { fetchImpl, map: { "kb-docs": "shared" } }))).rejects.toThrow(/kb-docs.*never imported; re-export without them/);
    expect(called).toBe(false);
  });
  test("a map whose target is kb-* is refused before any request", async () => {
    const d = await bundle([page("scratch", "a")]);
    let called = false;
    const fetchImpl = (async () => { called = true; return ok({}); }) as unknown as typeof fetch;
    await expect(runImport(base(d, { fetchImpl, map: { scratch: "kb-y" } }))).rejects.toThrow(/kb-\*/);
    expect(called).toBe(false);
  });
  test("a map into the reported agent slice reconciles with no mismatch", async () => {
    const d = await bundle([page("agent-default", "a"), page("scratch", "b")]);
    const fetchImpl = (async () => ok({ "agent-uana": 2 })) as unknown as typeof fetch;
    const s = await runImport(base(d, { fetchImpl, map: { scratch: "agent-uana" } }));
    expect(s.mismatches).toEqual([]);
  });
  test("a count mismatch against the manifest is reported", async () => {
    const fetchImpl = (async () => ok({ shared: 0 })) as unknown as typeof fetch;
    const s = await runImport(base(await bundle([page("shared", "a")]), { fetchImpl }));
    expect(s.mismatches.length).toBe(1);
    expect(hasProblems(s)).toBe(true);
  });
  test("a mismatch that onConflict skip accounts for is not a mismatch", async () => {
    const fetchImpl = (async () => reply({ shared: { skipped: 1 } })) as unknown as typeof fetch;
    const s = await runImport(base(await bundle([page("shared", "a")]), { fetchImpl }));
    expect(s.mismatches).toEqual([]);
    expect(hasProblems(s)).toBe(false);
  });
  test("user-slice failures (no slugs) and link failures still count as problems; reasons are summed", async () => {
    const pages = Array.from({ length: 150 }, (_, i) => page("user-u1", "p" + i));
    let call = 0;
    const fetchImpl = (async () => (++call === 1
      ? reply({ "user-u1": { failed: 100 } }, { failedReasons: { "error:X": 100 } })
      : reply({ "user-u1": { written: 50, linksFailed: 1 } }, { failedReasons: { "error:X": 2 } }))) as unknown as typeof fetch;
    const s = await runImport(base(await bundle(pages), { fetchImpl }));
    expect(s.failedSlugs).toEqual([]);
    expect(s.failedReasons).toEqual({ "error:X": 102 });
    expect(s.sources["user-u1"]!.linksFailed).toBe(1);
    expect(s.mismatches).toEqual([]);
    expect(hasProblems(s)).toBe(true);
  });
  test("healable drops trigger ONE automatic skip pass that reports what it wrote; the hint appears only if drops remain", async () => {
    const bodies: Array<{ onConflict: string; dryRun: boolean }> = [];
    let n = 0;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string)); n++;
      return n === 1 ? reply({ shared: { written: 1, linksWritten: 1, linksDropped: 3, linksOutOfScope: 1 } })
        : reply({ shared: { skipped: 1, linksWritten: 3, linksDropped: 1, linksOutOfScope: 1 } });
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    const s = await runImport(base(await bundle([page("shared", "secret-slug")]), { fetchImpl, log: (l) => lines.push(l) }));
    expect(bodies.map((b) => [b.onConflict, b.dryRun])).toEqual([["skip", false], ["skip", false]]);
    expect(s.linksHealed).toBe(2); // 3 links exist after pass 2, 1 was written in pass 1
    expect(s.sources.shared!.written).toBe(1); // reconciliation uses pass-1 counts
    expect(s.mismatches).toEqual([]);
    expect(lines).toContain("heal pass: 2 links written");
    expect(lines.some((l) => l.startsWith("1 links were not written because their target page was missing"))).toBe(false);
    expect(lines.some((l) => l.includes("kb-* or unmapped sources were not imported"))).toBe(true);
    expect(lines.join("\n")).not.toContain("secret-slug");
  });
  test("drops that survive the heal pass print the re-run hint; out-of-scope drops alone cause no heal pass; dry run and fail policy never heal", async () => {
    const count = async (over: Record<string, unknown>, counts: Record<string, number>) => {
      let n = 0; const lines: string[] = [];
      const fetchImpl = (async () => { n++; return reply({ shared: { written: 1, ...counts } }); }) as unknown as typeof fetch;
      await runImport(base(await bundle([page("shared", "a")]), { fetchImpl, log: (l) => lines.push(l), ...over }));
      return { n, lines };
    };
    const stuck = await count({}, { linksDropped: 2 });
    expect(stuck.n).toBe(2);
    expect(stuck.lines.some((l) => l.startsWith("2 links were not written") && l.includes("re-run the same command"))).toBe(true);
    expect((await count({}, { linksDropped: 2, linksOutOfScope: 2 })).n).toBe(1);
    expect((await count({ dryRun: true }, { linksDropped: 2 })).n).toBe(1);
    expect((await count({ onConflict: "fail" }, { linksDropped: 2 })).n).toBe(1);
  });
  test("in-bundle slug collisions are reported by source pair, never by slug, in a dry run too; same-source repeats are not collisions", async () => {
    const d = await bundle([page("agent-default", "cur"), page("agent", "cur"), page("agent", "only-legacy"), page("shared", "cur")]);
    const fetchImpl = (async () => ok({ "agent-uana": 3, shared: 1 })) as unknown as typeof fetch;
    for (const dryRun of [false, true]) {
      const lines: string[] = [];
      const s = await runImport(base(d, { fetchImpl, dryRun, log: (l) => lines.push(l) }));
      expect(s.collisions).toEqual({ count: 1, sources: ["agent vs agent-default"] });
      const line = lines.find((l) => l.includes("in-bundle slug collision"))!;
      expect(line).toContain("1 in-bundle slug collision(s)");
      expect(line).toContain("agent vs agent-default");
      expect(line).not.toContain("cur");
    }
  });
  test("each attempt carries a timeout signal; a hung attempt is aborted and retried", async () => {
    let n = 0; const waits: number[] = [];
    const fetchImpl = ((_u: string, init: RequestInit) => {
      n++;
      if (n === 1) return new Promise<Response>((_r, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))));
      return Promise.resolve(ok({ shared: 1 }));
    }) as unknown as typeof fetch;
    const s = await runImport(base(await bundle([page("shared", "a")]), { fetchImpl, timeoutMs: 20, sleep: async (ms) => { waits.push(ms); } }));
    expect(n).toBe(2);
    expect(waits).toEqual([500]);
    expect(s.sources.shared!.written).toBe(1);
  });
  test("429 is retried like a 5xx, with the same backoff; a persistent 429 fails clearly", async () => {
    let n = 0; const waits: number[] = [];
    const f1 = (async () => (++n < 3 ? new Response("slow down", { status: 429 }) : ok({ shared: 1 }))) as unknown as typeof fetch;
    await runImport(base(await bundle([page("shared", "a")]), { fetchImpl: f1, sleep: async (ms) => { waits.push(ms); } }));
    expect(n).toBe(3);
    expect(waits).toEqual([500, 1000]);
    const f2 = (async () => new Response("x", { status: 429 })) as unknown as typeof fetch;
    await expect(runImport(base(await bundle([page("shared", "a")]), { fetchImpl: f2 }))).rejects.toThrow(/after retries \(429\)/);
  });
  test("dryRun is forwarded", async () => {
    let body: { dryRun?: boolean } = {};
    const fetchImpl = (async (_u: string, init: RequestInit) => { body = JSON.parse(init.body as string); return ok({ shared: 1 }); }) as unknown as typeof fetch;
    await runImport(base(await bundle([page("shared", "a")]), { fetchImpl, dryRun: true }));
    expect(body.dryRun).toBe(true);
  });
  test("an empty bundle sends nothing and succeeds", async () => {
    let called = false;
    const s = await runImport(base(await bundle([]), { fetchImpl: (async () => { called = true; return ok({}); }) as unknown as typeof fetch }));
    expect(called).toBe(false);
    expect(s.mismatches).toEqual([]);
  });
});

describe("token handling", () => {
  test("client and CLI never reach for other secrets or take a token flag", () => {
    for (const f of ["src/cli/brain-import.ts", "src/brain-migrate/client.ts"]) {
      const src = readFileSync(join(import.meta.dir, "../..", f), "utf8");
      for (const bad of ["SLAUDE_JOB_SECRET", "SLAUDE_BRAIN_DATABASE_URL", "SLAUDE_PG_URL"]) expect(src).not.toContain(bad);
      expect(src).not.toMatch(/["']token["']\s*:\s*\{/);
    }
  });
});

describe("brain-import CLI", () => {
  const run = async (args: string[], env: Record<string, string> = {}) => {
    const p = Bun.spawn(["bun", join(import.meta.dir, "../../src/cli/brain-import.ts"), ...args], {
      env: { PATH: process.env.PATH ?? "", ...env }, stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out, err, code };
  };
  test("no args prints usage and exits 2", async () => {
    const r = await run([]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage: brain-import");
    expect(r.out).toBe("");
  });
  test("a missing token env exits 2 without a request", async () => {
    const r = await run(["--gateway", "http://127.0.0.1:1", "--persona", "ana", "/nonexistent"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("SLAUDE_BRAIN_IMPORT_TOKEN");
    expect(r.out).toBe("");
  });
});
