import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const brainDir = mkdtempSync(join(tmpdir(), "slaude-backfill-"));
process.env.SLAUDE_BRAIN_HOME = brainDir;

import { db } from "../src/db/schema";
import { backfillMemoryTurns } from "../src/knowledge/brain-backfill";
import { brainCall, closeBrain, ensureSources } from "../src/knowledge/brain";
import { AGENT_SOURCE } from "../src/knowledge/scope";

afterAll(async () => {
  await closeBrain();
  delete process.env.SLAUDE_BRAIN_HOME;
  rmSync(brainDir, { recursive: true, force: true });
  db.run("DELETE FROM memory_turns");
});

const DAY = 24 * 60 * 60 * 1000;

describe("backfillMemoryTurns (integration)", () => {
  test("imports historical sqlite turns as conversation pages + timeline", async () => {
    db.run("DELETE FROM memory_turns");
    const base = Date.now() - 21 * DAY;
    for (let s = 0; s < 3; s++) {
      for (let t = 0; t < 4; t++) {
        db.run(
          "INSERT INTO memory_turns (session_id, ts, user_text, assistant_text) VALUES (?, ?, ?, ?)",
          [`sess-${s}`, base + s * DAY + t * 60000, `question ${s}-${t} about flamingo rollout`, `answer ${s}-${t}`],
        );
      }
    }
    await ensureSources();
    const r = await backfillMemoryTurns();
    expect(r.sessions).toBe(3);
    expect(r.turns).toBe(12);
    expect(r.errors).toBe(0);

    const scope = { clientId: "agent", sourceId: AGENT_SOURCE, allowedSources: [AGENT_SOURCE] };
    const page = (await brainCall("get_page", { slug: "conversations/sess-1" }, scope)) as { slug: string };
    expect(page.slug).toBe("conversations/sess-1");
    const hits = (await brainCall("search", { query: "flamingo rollout" }, scope)) as unknown[];
    expect(hits.length).toBeGreaterThan(0);
  }, 120_000);

  test("re-run is idempotent (timeline dedup)", async () => {
    const r = await backfillMemoryTurns();
    expect(r.errors).toBe(0);
    const scope = { clientId: "agent", sourceId: AGENT_SOURCE, allowedSources: [AGENT_SOURCE] };
    const tl = (await brainCall("get_timeline", { slug: "conversations/sess-0" }, scope)) as unknown[];
    expect(tl.length).toBe(4); // not 8 after second run
  }, 120_000);
});
