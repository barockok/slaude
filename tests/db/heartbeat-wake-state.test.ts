import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as State from "../../src/db/heartbeat-wake-state";

beforeEach(async () => {
  await db.run("DELETE FROM heartbeat_wake_state");
});

describe("heartbeat wake state", () => {
  test("no row: null", async () => {
    expect(await State.get("A1")).toBeNull();
  });
  test("start, finish and settle build up one row per agent", async () => {
    await State.noteStart("A1", "h1", 100);
    await State.noteFinished("A1", 500, 150);
    await State.noteSettled("A1", { outcome: "ok", failures: 0, nextCheckAt: null }, 160);
    expect(await State.get("A1")).toEqual({ agentId: "A1", nextCheckAt: 500, lastWakeAt: 100, finishedAt: 150, lastOutcome: "ok", failures: 0, checklistHash: "h1" });
    expect(await State.get("A2")).toBeNull();
  });
  test("settling with a time replaces it; a later start keeps it", async () => {
    await State.noteFinished("A1", 500, 150);
    await State.noteSettled("A1", { outcome: "error", failures: 2, nextCheckAt: 900 }, 160);
    await State.noteStart("A1", "h2", 200);
    const s = await State.get("A1");
    expect(s?.nextCheckAt).toBe(900);
    expect(s?.failures).toBe(2);
    expect(s?.checklistHash).toBe("h2");
  });
});
