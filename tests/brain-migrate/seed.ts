// tests/brain-migrate/seed.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Dimension the test brains use (set from the Step 1 spike; gbrain's default pgvector column is vector(1280)). */
export const TEST_DIMS = 1280;
export const vec = (seed: number): number[] => Array.from({ length: TEST_DIMS }, (_, i) => Math.sin(seed + i) / 10);

/**
 * Build a MONO-mode brain at `home`: a default persona with no SLAUDE_AGENT_ID,
 * so its private mind is `agent-default` (what a single-agent deployment has).
 * Contents: conversation memory via BrainMemoryProvider, a person's slice,
 * shared/public pages with tags, a dated timeline entry, a link, embeddings,
 * and a kb-* page that must not travel.
 * Runs in the current process against SLAUDE_BRAIN_HOME=home, then closes the brain.
 */
export async function seedMonoBrain(home: string, o: { empty?: boolean } = {}): Promise<void> {
  mkdirSync(home, { recursive: true });
  process.env.SLAUDE_BRAIN_HOME = home;
  delete process.env.SLAUDE_AGENT_ID;
  const { closeBrain, getBrain, brainAdminCall } = await import("../../src/knowledge/brain");
  const { resetAgentId } = await import("../../src/knowledge/agent-identity");
  resetAgentId();
  try {
    const engine = (await getBrain()) as unknown as import("../../src/brain-migrate/engine-types").MigrateEngine;
    if (o.empty) return;
    // Not ensureSource(): its process-wide cache would skip sources_add for a second brain home in the same process.
    for (const s of ["agent-default", "shared", "public", "user-ualice", "kb-bulk-corpus"]) {
      await brainAdminCall("sources_add", { id: s, federated: true }).catch((e) => { if (!/duplicate key|already exists|already registered/i.test(String(e))) throw e; });
    }
    const { BrainMemoryProvider } = await import("../../src/memory/brain-provider");
    const mem = new BrainMemoryProvider();
    const session = "11111111-2222-3333-4444-555555555555";
    await mem.syncTurn({ sessionId: session, user: "what is the deploy cadence?", assistant: "weekly, thursdays" });
    await mem.syncTurn({ sessionId: session, user: "and the oncall?", assistant: "rotates monday" });
    const put = async (source: string, slug: string, truth: string, extra: Partial<{ tags: string[]; seed: number }> = {}) => {
      await engine.putPage(slug, { type: "note", title: slug, compiled_truth: truth }, { sourceId: source });
      await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: truth, chunk_source: "compiled_truth", embedding: Float32Array.from(vec(extra.seed ?? 1)), model: "test-embed", token_count: 4 }], { sourceId: source });
      for (const t of extra.tags ?? []) await engine.addTag(slug, t, { sourceId: source });
    };
    await put("agent-default", "learned/runbook", "Restart the worker with the zebra procedure.", { tags: ["ops"], seed: 2 });
    await engine.addTimelineEntry("learned/runbook", { date: "2024-03-05", source: "ops", summary: "wrote runbook" }, { sourceId: "agent-default" });
    await put("agent-default", "learned/index", "Index of runbooks. See [[learned/runbook]].", { seed: 3 });
    await engine.addLink("learned/index", "learned/runbook", "see", "references", "manual", undefined, undefined, { fromSourceId: "agent-default", toSourceId: "agent-default" });
    await engine.putRawData("learned/runbook", "ops-import", { k: "v" }, { sourceId: "agent-default" });
    await put("user-ualice", "people/alice", "Alice prefers quokka-themed standups.", { seed: 4 });
    await put("shared", "team/norms", "Team norm: narwhal reviews on Fridays.", { seed: 5 });
    await put("public", "faq/hours", "Public FAQ: pelican support hours.", { seed: 6 });
    await put("kb-bulk-corpus", "kb/page", "Bulk corpus page that must not travel.", { seed: 7 });
  } finally {
    await closeBrain();
  }
}
