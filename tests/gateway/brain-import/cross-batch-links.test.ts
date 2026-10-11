// A link whose target arrives in a LATER batch is dropped on the first run and
// healed by re-running the same command (skip is idempotent). Real PGLite brain,
// real endpoint, real client.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_DIMS, vec } from "../../brain-migrate/seed";

const home = mkdtempSync(join(tmpdir(), "bm-cross-batch-"));
const bundleDir = mkdtempSync(join(tmpdir(), "bm-cross-batch-bundle-"));
process.env.SLAUDE_BRAIN_HOME = home;
import { closeBrain, getBrain } from "../../../src/knowledge/brain";
import { createBrainImportApi } from "../../../src/gateway/brain-import/api";
import { BundleWriter, type BundlePage } from "../../../src/brain-migrate/bundle";
import { hasProblems, runImport } from "../../../src/brain-migrate/client";

afterAll(async () => { await closeBrain(); rmSync(home, { recursive: true, force: true }); rmSync(bundleDir, { recursive: true, force: true }); });

const TOKEN = "x".repeat(40);
const N = 105;
const slug = (i: number) => `p${String(i).padStart(3, "0")}`;
const page = (i: number): BundlePage => ({
  source: "agent-default", slug: slug(i), type: "note", title: slug(i), compiledTruth: `body ${i}`, timeline: "", frontmatter: {}, contentHash: null,
  chunks: [{ index: 0, text: `body ${i}`, source: "compiled_truth", embedding: vec(i), model: null, tokens: 2 }],
  tags: [], timelineEntries: [], raw: [],
  // p000 -> p104: the target is in the last batch, the source in the first
  links: i === 0 ? [{ toSource: "agent-default", toSlug: slug(N - 1), type: "references", context: "far" }] : [],
});

test("a link to a page in a later batch is dropped first and healed within the same command", async () => {
  const w = new BundleWriter(bundleDir);
  for (let i = 0; i < N; i++) await w.writePage(page(i));
  await w.finish({ engine: { schemaVersion: 1, embeddingModel: null, embeddingDimensions: TEST_DIMS }, excluded: [] });

  const api = createBrainImportApi({ env: () => ({ SLAUDE_BRAIN_IMPORT_TOKEN: TOKEN }), resolveAgentId: async (n) => (n === "ana" ? "UANA-1x" : null), log: () => {} });
  const run = (log: (l: string) => void = () => {}) => runImport({
    gateway: "https://gw.example.com", persona: "ana", token: TOKEN, bundle: bundleDir, sleep: async () => {}, log,
    fetchImpl: ((u: string, init: RequestInit) => api.fetch(new Request(u, init)).then((r) => r!)) as unknown as typeof fetch,
  });
  const e = (await getBrain()) as any;
  const linkCount = async () => (await e.executeRaw(
    `SELECT count(*)::int AS n FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
     WHERE f.slug = $1 AND t.slug = $2 AND f.source_id = 'agent-uana1x' AND t.source_id = 'agent-uana1x'`, [slug(0), slug(N - 1)]))[0].n as number;

  const lines: string[] = [];
  const first = await run((l) => lines.push(l));
  // ONE command: pass 1 drops the cross-batch link, the automatic heal pass writes it.
  expect(first.mismatches).toEqual([]);
  expect(hasProblems(first)).toBe(false);
  expect(first.sources["agent-uana1x"]!.written).toBe(N);
  expect(first.sources["agent-uana1x"]!.linksDropped).toBeGreaterThanOrEqual(1);
  expect(first.linksHealed).toBeGreaterThanOrEqual(1);
  expect(lines.some((l) => l.startsWith("heal pass:"))).toBe(true);
  expect(lines.some((l) => l.includes("were not written because their target page was missing"))).toBe(false);
  expect(await linkCount()).toBe(1);

  const second = await run();
  expect(second.mismatches).toEqual([]);
  expect(second.sources["agent-uana1x"]!.skipped).toBe(N);
  expect(second.sources["agent-uana1x"]!.written).toBe(0);
  expect(second.sources["agent-uana1x"]!.linksWritten).toBe(1);
  expect(second.sources["agent-uana1x"]!.linksDropped).toBe(0);
  expect(second.linksHealed).toBe(0);
  expect(await linkCount()).toBe(1);
}, 180_000);
