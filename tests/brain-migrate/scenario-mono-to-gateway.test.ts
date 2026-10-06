// The operator's acceptance test: a mono-mode agent's default slice is exported,
// imported through the real client into the real endpoint on a separate fresh
// brain under a named persona, and the persona must still recall everything.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedMonoBrain } from "./seed";
import { SESSION, dryRunStep, identity, importStep, importer, recallStep, rerunStep, scopeOf, search, useBrain } from "./scenario-steps";

const root = mkdtempSync(join(tmpdir(), "bm-scenario-"));
const monoHome = join(root, "mono");
const gwHome = join(root, "gateway");
const gwDefaultHome = join(root, "gateway-default");
const bundleDir = join(root, "bundle");
const savedHome = process.env.SLAUDE_BRAIN_HOME;
const savedAgent = process.env.SLAUDE_AGENT_ID;

afterAll(async () => {
  const { closeBrain } = await import("../../src/knowledge/brain");
  const { resetAgentId } = await import("../../src/knowledge/agent-identity");
  await closeBrain();
  resetAgentId();
  if (savedHome === undefined) delete process.env.SLAUDE_BRAIN_HOME; else process.env.SLAUDE_BRAIN_HOME = savedHome;
  if (savedAgent === undefined) delete process.env.SLAUDE_AGENT_ID; else process.env.SLAUDE_AGENT_ID = savedAgent;
  rmSync(root, { recursive: true, force: true });
});

describe("mono default slice -> gateway persona: memory remains", () => {
  test("1. mono: the old agent remembers in agent-default", async () => {
    await seedMonoBrain(monoHome);
    await useBrain(monoHome);
    await identity(null); // mono: no SLAUDE_AGENT_ID, no auth.test -> "default"
    const { agentScope } = await import("../../src/knowledge/agent-identity");
    expect(agentScope().sourceId).toBe("agent-default");
    const hits = await search("zebra procedure", agentScope());
    expect(hits.some((h) => h.slug === "learned/runbook")).toBe(true);
    const { BrainMemoryProvider } = await import("../../src/memory/brain-provider");
    const block = await new BrainMemoryProvider().prefetch(SESSION);
    expect(block).toContain("deploy cadence");
    expect(block).toContain("rotates monday");
  }, 120_000);

  test("2. export the mono brain", async () => {
    const { closeBrain } = await import("../../src/knowledge/brain");
    await closeBrain();
    const { exportBrain } = await import("../../src/brain-migrate/export");
    const { manifest } = await exportBrain({ home: monoHome, out: bundleDir });
    expect(manifest.sources.map((s) => s.id)).toContain("agent-default");
    expect(manifest.excluded).toContain("kb-bulk-corpus");
  }, 120_000);

  test("3. dry run into a fresh gateway brain reports the target and writes nothing", async () => {
    await useBrain(gwHome);
    await identity("UANA-1x");
    await dryRunStep(bundleDir);
  }, 120_000);

  test("4. real import: counts reconcile", () => importStep(bundleDir), 120_000);

  test("5. the persona recalls everything through the gateway's own read paths", () => recallStep(), 120_000);

  test("6. isolation: other agents and other people do not see the migrated private slices", async () => {
    const { agentSourceForPersona } = await import("../../src/brain-migrate/remap");
    const other = scopeOf(agentSourceForPersona("UOTHER"));
    expect((await search("zebra procedure", other)).length).toBe(0);
    const alice = scopeOf("user-ualice", ["shared"]);
    const bob = scopeOf("shared");
    expect((await search("quokka", alice)).length).toBeGreaterThan(0);
    expect((await search("quokka", bob)).length).toBe(0);
    expect((await search("narwhal", bob)).length).toBeGreaterThan(0);
    expect((await search("pelican", scopeOf("public"))).length).toBeGreaterThan(0);
    expect((await search("bulk corpus", scopeOf("agent-uana1x", ["shared", "public", "user-ualice"]))).length).toBe(0);
  }, 120_000);

  test("7. re-run is idempotent; a crashed run resumes", () => rerunStep(bundleDir), 120_000);

  test("8. a new write after the move works and the old memory is intact", async () => {
    const { agentScope } = await import("../../src/knowledge/agent-identity");
    const { brainCall } = await import("../../src/knowledge/brain");
    const { BrainMemoryProvider } = await import("../../src/memory/brain-provider");
    await brainCall("put_page", { slug: "learned/new", content: "Fresh note about a platypus." }, agentScope());
    expect((await search("platypus", agentScope())).length).toBeGreaterThan(0);
    expect((await search("zebra procedure", agentScope())).length).toBeGreaterThan(0);
    const fresh = "99999999-8888-7777-6666-555555555555";
    const mem = new BrainMemoryProvider();
    await mem.syncTurn({ sessionId: fresh, user: "hello new session", assistant: "hi there" });
    expect(await mem.prefetch(fresh)).toContain("hi there");
    const { getBrain } = await import("../../src/knowledge/brain");
    const e = (await getBrain()) as any;
    const rows = (await e.db.query(`SELECT source_id FROM pages WHERE slug LIKE $1`, [`%${fresh}%`])).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: { source_id: string }) => r.source_id === "agent-uana1x")).toBe(true);
  }, 120_000);

  test("9. the same bundle into the default persona lands in the process agent's slice", async () => {
    await useBrain(gwDefaultHome);
    await identity("UBOTDEF");
    const run = await importer(bundleDir, "default", "UBOTDEF");
    const s = await run();
    expect(s.agentSource).toBe("agent-ubotdef");
    expect(s.mismatches).toEqual([]);
    expect(s.failedSlugs).toEqual([]);
    expect(s.sources["agent-ubotdef"]!.written).toBe(3);
    const { agentScope } = await import("../../src/knowledge/agent-identity");
    expect(agentScope().sourceId).toBe("agent-ubotdef");
    const hits = await search("zebra procedure", agentScope());
    expect(hits.some((h) => h.slug === "learned/runbook")).toBe(true);
    const { BrainMemoryProvider } = await import("../../src/memory/brain-provider");
    expect(await new BrainMemoryProvider().prefetch(SESSION)).toContain("rotates monday");
  }, 120_000);
});
