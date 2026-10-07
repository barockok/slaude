// tests/brain-migrate/export.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedMonoBrain, TEST_DIMS } from "./seed";

const root = mkdtempSync(join(tmpdir(), "bm-export-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

import { exportBrain, orderSources, selectSources } from "../../src/brain-migrate/export";
import { readManifest, readPages, verifyBundle, type BundlePage } from "../../src/brain-migrate/bundle";

describe("selectSources", () => {
  test("default drops kb-*; include and exclude override by id or kb- prefix", () => {
    const all = ["agent-default", "shared", "public", "kb-a", "user-u1"];
    expect(selectSources(all, undefined, undefined)).toEqual({ keep: ["agent-default", "shared", "public", "user-u1"], excluded: ["kb-a"] });
    expect(selectSources(all, ["shared"], undefined).keep).toEqual(["shared"]);
    expect(selectSources(all, undefined, ["public", "kb-"]).keep).toEqual(["agent-default", "shared", "user-u1"]);
  });
});

describe("orderSources", () => {
  test("agent-like sources go most specific first (real id, agent-default, legacy agent); others keep their slots", () => {
    expect(orderSources(["agent", "agent-default", "agent-ubb", "agent-uaa", "public", "shared", "user-u1"]))
      .toEqual(["agent-uaa", "agent-ubb", "agent-default", "agent", "public", "shared", "user-u1"]);
    expect(orderSources(["agent", "agent-default", "shared"])).toEqual(["agent-default", "agent", "shared"]);
    expect(orderSources(["shared", "public"])).toEqual(["shared", "public"]);
  });
});

describe("exportBrain", () => {
  test("exports a mono brain without touching the original", async () => {
    const home = join(root, "mono");
    await seedMonoBrain(home);
    const out = join(root, "bundle");
    const { manifest } = await exportBrain({ home, out });
    expect(manifest.sources.map((s) => s.id).sort()).toEqual(["agent", "agent-default", "public", "shared", "user-ualice"]);
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
    // the current agent-default copy precedes the legacy agent copy of the same slug
    const order = pages.filter((p) => p.slug === "learned/runbook").map((p) => p.source);
    expect(order).toEqual(["agent-default", "agent"]);
    // link provenance travels: both a manual and a markdown edge, without an origin here
    const idx = pages.find((p) => p.source === "agent-default" && p.slug === "learned/index")!;
    expect(idx.links.map((l) => l.linkSource).sort()).toEqual(["manual", "markdown"]);
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

  test("a live lock in the original db dir is not copied and not touched", async () => {
    const home = join(root, "locked");
    await seedMonoBrain(home);
    const lockDir = join(home, "db", ".gbrain-lock");
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "lock"), JSON.stringify({ pid: process.pid, acquired_at: Date.now(), command: "test" }));
    const before = readdirSync(lockDir).sort();
    const t0 = Date.now();
    await exportBrain({ home, out: join(root, "locked-bundle") });
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(readdirSync(lockDir).sort()).toEqual(before);
  }, 120_000);

  test("a failure after the copy leaves no temp copy behind", async () => {
    const home = join(root, "garbage");
    mkdirSync(join(home, "db"), { recursive: true });
    writeFileSync(join(home, "db", "PG_VERSION"), "not a database");
    const list = () => readdirSync(tmpdir()).filter((n) => n.startsWith("brain-export-")).sort();
    const before = list();
    await expect(exportBrain({ home, out: join(root, "garbage-bundle") })).rejects.toThrow();
    expect(list()).toEqual(before);
  }, 120_000);

  test("a missing home is a clear error", async () => {
    await expect(exportBrain({ home: join(root, "nope"), out: join(root, "x") })).rejects.toThrow(/brain home/i);
  });
});
