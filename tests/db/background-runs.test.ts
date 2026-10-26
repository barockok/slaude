import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Runs from "../../src/db/background-runs";

const T = { input: 100, output: 50, cache_read: 10, cache_write: 5 };

async function run(agentId: string, pass: string, day: string, cost: number, outcome: Runs.RunOutcome, startedAt?: number) {
  const id = await Runs.start({ agentId, pass, scope: "agent", model: "m", day, startedAt });
  await Runs.finish(id, { tokens: T, costUsd: cost, outcome });
  return id;
}

beforeEach(async () => {
  await db.run("DELETE FROM background_runs");
});

describe("background_runs repo", () => {
  test("start/finish round-trips tokens, cost and outcome", async () => {
    const id = await Runs.start({ agentId: "a1", pass: "nightly-review", scope: "user:U0ALICE", model: "m", day: "2026-10-26" });
    const [open] = (await Runs.listBetween("a1", "2026-10-26", "2026-10-26")) as [Runs.BackgroundRun];
    expect(open.outcome).toBeNull();
    expect(open.finishedAt).toBeNull();
    await Runs.finish(id, { tokens: T, costUsd: 0.123, outcome: "ok" });
    const [r] = (await Runs.listBetween("a1", "2026-10-26", "2026-10-26")) as [Runs.BackgroundRun];
    expect(r).toMatchObject({ id, agentId: "a1", pass: "nightly-review", scope: "user:U0ALICE", model: "m", outcome: "ok", day: "2026-10-26" });
    expect(r.tokens).toEqual(T);
    expect(r.costUsd).toBeCloseTo(0.123);
    expect(r.finishedAt).not.toBeNull();
  });

  test("spentOn sums only that agent and that day", async () => {
    await run("a1", "nightly-review", "2026-10-26", 0.2, "ok");
    await run("a1", "skill-check", "2026-10-26", 0.05, "ok");
    await run("a1", "skill-check", "2026-10-25", 0.9, "ok");
    await run("a2", "skill-check", "2026-10-26", 0.7, "ok");
    expect(await Runs.spentOn("a1", "2026-10-26")).toBeCloseTo(0.25);
    expect(await Runs.spentOn("a1", "2026-10-27")).toBe(0);
  });

  test("lastOkCost returns the newest ok run only", async () => {
    expect(await Runs.lastOkCost("a1", "skill-review")).toBeNull();
    await run("a1", "skill-review", "2026-10-24", 0.3, "ok", 1000);
    await run("a1", "skill-review", "2026-10-25", 0.4, "ok", 2000);
    await run("a1", "skill-review", "2026-10-26", 9, "error", 3000);
    expect(await Runs.lastOkCost("a1", "skill-review")).toBeCloseTo(0.4);
  });

  test("ranOn ignores skipped-budget and unfinished rows by default", async () => {
    await run("a1", "nightly-review", "2026-10-26", 0, "skipped-budget");
    await Runs.start({ agentId: "a1", pass: "nightly-review", scope: "agent", day: "2026-10-26" });
    expect(await Runs.ranOn("a1", "nightly-review", "2026-10-26")).toBe(false);
    await run("a1", "nightly-review", "2026-10-26", 0.1, "stopped-budget");
    expect(await Runs.ranOn("a1", "nightly-review", "2026-10-26")).toBe(true);
    expect(await Runs.ranOn("a1", "nightly-review", "2026-10-25")).toBe(false);
  });

  test("listBetween is inclusive and ordered", async () => {
    await run("a1", "digest", "2026-10-20", 0, "ok", 1);
    await run("a1", "digest", "2026-10-22", 0, "ok", 2);
    await run("a1", "digest", "2026-10-26", 0, "ok", 3);
    const rows = await Runs.listBetween("a1", "2026-10-22", "2026-10-26");
    expect(rows.map((r) => r.day)).toEqual(["2026-10-22", "2026-10-26"]);
  });
});
