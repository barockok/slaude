// tests/brain-migrate/export.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedMonoBrain, TEST_DIMS } from "./seed";

const root = mkdtempSync(join(tmpdir(), "bm-export-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

import { exportBrain, selectSources } from "../../src/brain-migrate/export";
import { readManifest, readPages, verifyBundle, type BundlePage } from "../../src/brain-migrate/bundle";

describe("selectSources", () => {
  test("default drops kb-*; include and exclude override by id or kb- prefix", () => {
    const all = ["agent-default", "shared", "public", "kb-a", "user-u1"];
    expect(selectSources(all, undefined, undefined)).toEqual({ keep: ["agent-default", "shared", "public", "user-u1"], excluded: ["kb-a"] });
    expect(selectSources(all, ["shared"], undefined).keep).toEqual(["shared"]);
    expect(selectSources(all, undefined, ["public", "kb-"]).keep).toEqual(["agent-default", "shared", "user-u1"]);
  });
});

describe("exportBrain", () => {
  test("exports a mono brain without touching the original", async () => {
    const home = join(root, "mono");
    await seedMonoBrain(home);
    const out = join(root, "bundle");
    const { manifest } = await exportBrain({ home, out });
    expect(manifest.sources.map((s) => s.id).sort()).toEqual(["agent-default", "public", "shared", "user-ualice"]);
    expect(manifest.excluded).toContain("kb-bulk-corpus");
    expect(manifest.engine.embeddingDimensions).toBe(TEST_DIMS);
    await verifyBundle(out);
    const pages: BundlePage[] = [];
    for await (const p of readPages(out)) pages.push(p);
    const mem = pages.find((p) => p.source === "agent-default" && p.slug.startsWith("conversations/"))!;
    expect(JSON.stringify(mem.timelineEntries)).toContain("deploy cadence"); // turns are timeline entries, not compiled_truth
    const emb = pages.find((p) => p.chunks.some((c) => c.embedding))!;
    expect(emb.chunks.find((c) => c.embedding)!.embedding!.length).toBe(TEST_DIMS);
    const withTimeline = pages.find((p) => p.slug === "learned/runbook")!; // the conversation page also has (today-dated) entries
    expect(withTimeline.timelineEntries[0]!.date).toBe("2024-03-05"); // original date, not today
    expect(pages.some((p) => p.tags.includes("ops"))).toBe(true);
    expect(pages.some((p) => p.links.length > 0)).toBe(true);
    expect(pages.every((p) => !p.source.startsWith("kb-"))).toBe(true);
    // original brain dir still opens (no lock taken, nothing deleted)
    expect(existsSync(join(home, "db"))).toBe(true);
  }, 120_000);

  test("an empty brain exports a valid zero-page bundle", async () => {
    const home = join(root, "empty");
    await seedMonoBrain(home, { empty: true });
    const out = join(root, "empty-bundle");
    const { manifest } = await exportBrain({ home, out });
    expect(manifest.sources).toEqual([]);
    expect(readManifest(out).files["pages.jsonl"]).toMatch(/^[0-9a-f]{64}$/);
  }, 120_000);

  test("a missing home is a clear error", async () => {
    await expect(exportBrain({ home: join(root, "nope"), out: join(root, "x") })).rejects.toThrow(/brain home/i);
  });
});
