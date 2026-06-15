import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "slaude-gather-test-"));
process.env.SLAUDE_BRAIN_HOME = home;

import { brainCall, closeBrain, ensureSources, getBrain } from "../src/knowledge/brain";
import { gather, rankScore } from "../src/knowledge/gather";
import type { BrainScope } from "../src/knowledge/scope";

afterAll(async () => {
  await closeBrain();
  rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Deterministic unit tests — inject `call`, no real brain. These prove the
// per-source guarantee precisely and are immune to the process-global brain
// singleton other test files share (which makes seed-count-dependent
// integration assertions flaky in the full suite).
// ---------------------------------------------------------------------------

const scope = (sources: string[]): BrainScope => ({
  clientId: "U",
  sourceId: sources[0] ?? "shared",
  allowedSources: sources,
});

describe("gather (unit, injected call)", () => {
  test("fans out exactly one search per allowed source", async () => {
    const seen: string[] = [];
    const call = async (_n: string, _p: Record<string, unknown>, s: BrainScope) => {
      seen.push(s.allowedSources[0]!);
      expect(s.allowedSources).toHaveLength(1); // each fan-out is single-source
      return [{ slug: `${s.allowedSources[0]}/p`, rerank_score: 0.5 }];
    };
    await gather("q", scope(["shared", "bulk-corpus", "public"]), { call });
    expect(seen.sort()).toEqual(["bulk-corpus", "public", "shared"]);
  });

  test("curated page is never crowded out — guaranteed its own slots", async () => {
    // The flood: one curated source with a single good page, one noise source
    // returning many higher-base-score-but-junk hits. Per-source K guarantees
    // the curated page enters the pool; the reranker then sorts it to the top.
    const call = async (_n: string, _p: Record<string, unknown>, s: BrainScope) => {
      if (s.allowedSources[0] === "curated") return [{ slug: "org/team-directory", rerank_score: 0.95 }];
      return Array.from({ length: 24 }, (_, i) => ({ slug: `bulk/stub_${i}`, rerank_score: 0.06, score: 0.9 }));
    };
    const hits = await gather("team directory lookup", scope(["curated", "bulk-corpus"]), { perSourceK: 5, call });
    expect(hits.some((h) => h.slug === "org/team-directory")).toBe(true);
    expect(hits[0]!.slug).toBe("org/team-directory"); // reranker sorts it #1
  });

  test("does not kill the noise source — bulk still present when wanted", async () => {
    const call = async (_n: string, _p: Record<string, unknown>, s: BrainScope) =>
      s.allowedSources[0] === "bulk-corpus"
        ? [{ slug: "bulk/model_3", rerank_score: 0.4 }]
        : [{ slug: "curated/x", rerank_score: 0.2 }];
    const hits = await gather("model_3", scope(["curated", "bulk-corpus"]), { call });
    expect(hits.some((h) => typeof h.slug === "string" && h.slug.startsWith("bulk/"))).toBe(true);
  });

  test("dedups by slug, keeping the higher-ranked chunk", async () => {
    const call = async (_n: string, _p: Record<string, unknown>, s: BrainScope) =>
      s.allowedSources[0] === "a"
        ? [{ slug: "dup", rerank_score: 0.3 }]
        : [{ slug: "dup", rerank_score: 0.8 }];
    const hits = await gather("q", scope(["a", "b"]), { call });
    expect(hits.filter((h) => h.slug === "dup")).toHaveLength(1);
    expect(rankScore(hits[0]!)).toBe(0.8);
  });

  test("respects finalLimit and sorts by effective rank", async () => {
    const call = async (_n: string, _p: Record<string, unknown>, s: BrainScope) =>
      Array.from({ length: 6 }, (_, i) => ({ slug: `${s.allowedSources[0]}/${i}`, rerank_score: i / 10 }));
    const hits = await gather("q", scope(["a", "b"]), { perSourceK: 6, finalLimit: 5, call });
    expect(hits).toHaveLength(5);
    for (let i = 1; i < hits.length; i++) {
      expect(rankScore(hits[i - 1]!)).toBeGreaterThanOrEqual(rankScore(hits[i]!));
    }
  });

  test("falls back to a hit's score when rerank_score absent", async () => {
    const call = async () => [{ slug: "p", score: 0.7 }];
    const hits = await gather("q", scope(["a"]), { call });
    expect(rankScore(hits[0]!)).toBe(0.7);
  });

  test("empty allowedSources falls back to sourceId", async () => {
    const seen: string[] = [];
    const call = async (_n: string, _p: Record<string, unknown>, s: BrainScope) => {
      seen.push(s.allowedSources[0]!);
      return [{ slug: "p", rerank_score: 0.5 }];
    };
    await gather("q", { clientId: "U", sourceId: "only-src", allowedSources: [] }, { call });
    expect(seen).toEqual(["only-src"]);
  });

  test("one source failing is tolerated; its results just drop", async () => {
    const call = async (_n: string, _p: Record<string, unknown>, s: BrainScope) => {
      if (s.allowedSources[0] === "bad") throw new Error("transient");
      return [{ slug: "good/p", rerank_score: 0.5 }];
    };
    const hits = await gather("q", scope(["good", "bad"]), { call });
    expect(hits.map((h) => h.slug)).toEqual(["good/p"]);
  });

  test("total failure (every source errors) rethrows — never papers over a down brain", async () => {
    const call = async () => { throw new Error("db on fire"); };
    expect(gather("q", scope(["a", "b"]), { call })).rejects.toThrow(/db on fire/);
  });
});

// ---------------------------------------------------------------------------
// Real-brain smoke — proves gather() wires correctly to gbrain's `search` op
// end-to-end. Self-contained: seeds and asserts inside the single test body so
// no cross-file singleton reset can wipe the data between setup and assertion.
// Uses a test-private source id so other files' `shared` seeds don't bleed in.
// ---------------------------------------------------------------------------

describe("gather (real gbrain search)", () => {
  test("end-to-end: finds a seeded curated page in a unique source", async () => {
    const SRC = "tg-smoke";
    await getBrain();
    await ensureSources([SRC]);
    const seed: BrainScope = { clientId: "seed", sourceId: SRC, allowedSources: [SRC] };
    await brainCall(
      "put_page",
      {
        slug: "org/team-directory-platform",
        content: "# Platform Team\n\n**PM Lead:** Jane Doe\n**EM:** John Roe",
      },
      seed,
    );
    const hits = await gather("Jane Doe platform team PM", { clientId: "U", sourceId: SRC, allowedSources: [SRC] });
    expect(hits.some((h) => h.slug === "org/team-directory-platform")).toBe(true);
  }, 120_000);
});
