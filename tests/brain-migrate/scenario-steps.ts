// Phase bodies shared by the PGLite scenario and the gated Postgres scenario.
import { expect } from "bun:test";
import { vec } from "./seed";
import type { BrainScope } from "../../src/knowledge/scope";

export const TOKEN = "s".repeat(40);
export const SESSION = "11111111-2222-3333-4444-555555555555";

export const useBrain = async (home: string) => {
  const { closeBrain } = await import("../../src/knowledge/brain");
  await closeBrain();
  process.env.SLAUDE_BRAIN_HOME = home;
};
export const identity = async (id: string | null) => {
  const m = await import("../../src/knowledge/agent-identity");
  m.resetAgentId();
  if (id) m.setAgentId(id);
};
// The real endpoint with its real default embedding derivation (no brainConfig injected).
export const importer = async (bundleDir: string, persona: string, agentId: string) => {
  const { createBrainImportApi } = await import("../../src/gateway/brain-import/api");
  const { runImport } = await import("../../src/brain-migrate/client");
  const api = createBrainImportApi({
    env: () => ({ SLAUDE_BRAIN_IMPORT_TOKEN: TOKEN }),
    // The default persona resolves through the real path (the process agent id, set by identity()).
    ...(persona === "default" ? {} : { resolveAgentId: async (n: string) => (n === persona ? agentId : null) }),
    log: () => {},
  });
  return (extra: Record<string, unknown> = {}) => runImport({
    gateway: "https://gw.example.com", persona, token: TOKEN, bundle: bundleDir, sleep: async () => {}, log: () => {},
    fetchImpl: ((u: string, init: RequestInit) => api.fetch(new Request(u, init)).then((r) => r!)) as unknown as typeof fetch,
    ...extra,
  });
};
export const search = async (q: string, scope: BrainScope) => {
  const { brainCall } = await import("../../src/knowledge/brain");
  return (await brainCall("search", { query: q }, scope)) as Array<{ slug?: string; source_id?: string }>;
};
export const scopeOf = (src: string, extra: string[] = []): BrainScope => ({ clientId: src, sourceId: src, allowedSources: [src, ...extra] });
const day = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

/** Dry run into a fresh gateway brain: reports the target, writes nothing. */
export async function dryRunStep(bundleDir: string) {
  const run = await importer(bundleDir, "ana", "UANA-1x");
  const s = await run({ dryRun: true });
  expect(s.agentSource).toBe("agent-uana1x");
  // learned/runbook, learned/index, the conversation page, and the legacy `agent` copy of
  // learned/runbook: a dry run writes nothing, so it cannot see that the last one collides.
  expect(s.sources["agent-uana1x"]!.written).toBe(4);
  expect(s.collisions).toEqual({ count: 1, sources: ["agent vs agent-default"] });
  const { getBrain } = await import("../../src/knowledge/brain");
  const e = (await getBrain()) as any;
  expect((await e.executeRaw("SELECT count(*)::int AS n FROM pages"))[0].n).toBe(0);
}

/** Real import: counts reconcile. */
export async function importStep(bundleDir: string) {
  const run = await importer(bundleDir, "ana", "UANA-1x");
  const s = await run();
  expect(s.mismatches).toEqual([]);
  expect(s.failedSlugs).toEqual([]);
  // agent-default holds learned/runbook, learned/index and the one conversation page
  // BrainMemoryProvider created for SESSION (two syncTurns, same page): 3 written. The legacy
  // `agent` slice holds an OLDER learned/runbook; the export writes it after agent-default's, so
  // under skip it is the one skipped, and the summary reports the collision.
  expect(s.sources["agent-uana1x"]!.written).toBe(3);
  expect(s.sources["agent-uana1x"]!.skipped).toBe(1);
  expect(s.collisions).toEqual({ count: 1, sources: ["agent vs agent-default"] });
  expect(s.sources["user-ualice"]!.written).toBe(1);
  expect(s.sources["shared"]!.written).toBe(1);
  expect(s.sources["public"]!.written).toBe(1);
  expect(s.sources["agent-uana1x"]!.linksWritten).toBe(2); // the manual edge and the markdown edge learned/index -> learned/runbook
  for (const c of Object.values(s.sources)) { expect(c.failed).toBe(0); expect(c.linksFailed).toBe(0); }
  expect(Object.keys(s.sources).some((k) => k.startsWith("kb-"))).toBe(false);
  expect(Object.keys(s.sources)).not.toContain("agent-default");
}

/** The persona recalls everything through the gateway's own read paths. */
export async function recallStep() {
  const { agentScope } = await import("../../src/knowledge/agent-identity");
  const { getBrain } = await import("../../src/knowledge/brain");
  expect(agentScope().sourceId).toBe("agent-uana1x");
  const hits = await search("zebra procedure", agentScope());
  expect(hits.some((h) => h.slug === "learned/runbook")).toBe(true);
  const { BrainMemoryProvider } = await import("../../src/memory/brain-provider");
  const mem = new BrainMemoryProvider();
  const block = await mem.prefetch(SESSION);
  expect(block).toContain("deploy cadence");
  expect(block).toContain("rotates monday");
  await mem.syncTurn({ sessionId: SESSION, user: "after the move?", assistant: "still here" });
  const after = await mem.prefetch(SESSION);
  expect(after).toContain("deploy cadence");
  expect(after).toContain("still here");

  const e = (await getBrain()) as any;
  const opts = { sourceId: "agent-uana1x" };
  const ch = await e.getChunksWithEmbeddings("learned/runbook", opts);
  const got = Array.from(ch[0].embedding as Float32Array);
  expect(got.length).toBe(vec(2).length);
  for (let i = 0; i < got.length; i++) expect(Math.abs(got[i]! - vec(2)[i]!)).toBeLessThan(1e-5);
  expect(ch[0].model).toBe("test-embed");
  expect(await e.getTags("learned/runbook", opts)).toContain("ops");
  expect(day((await e.getTimeline("learned/runbook", opts))[0].date)).toBe("2024-03-05");
  expect((await e.getRawData("learned/runbook", undefined, opts))[0].data).toEqual({ k: "v" });
  const links = (await e.executeRaw(
    `SELECT count(*)::int AS n FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
     WHERE f.slug = 'learned/index' AND t.slug = 'learned/runbook' AND f.source_id = 'agent-uana1x' AND t.source_id = 'agent-uana1x'`,
  ))[0].n;
  expect(links).toBe(2);
  const bySource = (await e.executeRaw(
    `SELECT l.link_source AS s FROM links l JOIN pages f ON f.id = l.from_page_id
     WHERE f.slug = 'learned/index' AND f.source_id = 'agent-uana1x' ORDER BY 1`,
  )).map((r: { s: string }) => r.s);
  expect(bySource).toEqual(["manual", "markdown"]); // provenance survived the move
  // the persona's copy is the current (agent-default) text, not the legacy slice's older one
  const truth = (await e.executeRaw(`SELECT compiled_truth AS t FROM pages WHERE slug = 'learned/runbook' AND source_id = 'agent-uana1x'`))[0].t as string;
  expect(truth).toContain("zebra procedure");
  expect(truth).not.toContain("okapi");
  // The brain's own boot may register kb-* sources for KBs installed in the test home (CI shares one
  // process and home across files), so assert on what the IMPORT could have written: no kb-* pages,
  // and the mono brain's kb source never arrived.
  expect((await e.executeRaw(`SELECT count(*)::int AS n FROM pages WHERE source_id LIKE 'kb-%'`))[0].n).toBe(0);
  expect((await e.executeRaw(`SELECT count(*)::int AS n FROM sources WHERE id = 'kb-bulk-corpus'`))[0].n).toBe(0);
  expect((await e.executeRaw(`SELECT count(*)::int AS n FROM pages WHERE slug = 'kb/page'`))[0].n).toBe(0);
}

/** Re-run is idempotent; a crashed run resumes. */
export async function rerunStep(bundleDir: string) {
  const run = await importer(bundleDir, "ana", "UANA-1x");
  const s = await run();
  for (const c of Object.values(s.sources)) { expect(c.written).toBe(0); expect(c.failed).toBe(0); expect(c.skipped).toBeGreaterThan(0); }
  expect(s.mismatches).toEqual([]);
  const { getBrain } = await import("../../src/knowledge/brain");
  const e = (await getBrain()) as any;
  await e.executeRaw(`DELETE FROM pages WHERE slug IN ('learned/index','team/norms')`);
  const s2 = await run();
  expect(s2.sources["agent-uana1x"]!.written).toBe(1);
  expect(s2.sources["shared"]!.written).toBe(1);
  // learned/index was deleted with its outgoing link; the resumed write restores it.
  expect(s2.sources["agent-uana1x"]!.linksWritten).toBe(2);
  const restored = (await e.executeRaw(
    `SELECT count(*)::int AS n FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
     WHERE f.slug = 'learned/index' AND t.slug = 'learned/runbook' AND f.source_id = 'agent-uana1x' AND t.source_id = 'agent-uana1x'`,
  ))[0].n;
  expect(restored).toBe(2);
  expect(Object.values(s2.sources).reduce((n, c) => n + c.written, 0)).toBe(2);
  expect(s2.mismatches).toEqual([]);
  expect(s2.failedSlugs).toEqual([]);
}
