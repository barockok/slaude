import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as S from "../../src/db/channel-wake-state";

beforeEach(async () => {
  await db.run("DELETE FROM channel_wake_state");
});

describe("channel wake state", () => {
  test("no row: null", async () => {
    expect(await S.get("A1", "C1")).toBeNull();
  });
  test("rows are per agent and channel", async () => {
    await S.noteStart("A1", "C1", "h", "run1", 100);
    await S.noteFinished("A1", "C1", 500, 150);
    await S.noteStart("A1", "C2", "h", "run2", 110);
    expect((await S.get("A1", "C1"))?.nextCheckAt).toBe(500);
    expect((await S.get("A1", "C2"))?.nextCheckAt).toBeNull();
    expect(await S.get("A2", "C1")).toBeNull();
  });
  test("start, finish and settle build up one row", async () => {
    await S.noteStart("A1", "C1", "h1", "run1", 100);
    await S.noteFinished("A1", "C1", 500, 150);
    await S.noteSettled("A1", "C1", { outcome: "ok", failures: 0, nextCheckAt: null }, 160);
    expect(await S.get("A1", "C1")).toEqual({ agentId: "A1", channelId: "C1", nextCheckAt: 500, lastWakeAt: 100, finishedAt: 150, lastOutcome: "ok", failures: 0, checklistHash: "h1" });
  });
  test("settling with a time replaces it; a later start keeps it", async () => {
    await S.noteFinished("A1", "C1", 500, 150);
    await S.noteSettled("A1", "C1", { outcome: "error", failures: 2, nextCheckAt: 900 }, 160);
    await S.noteStart("A1", "C1", "h2", "run2", 200);
    const s = await S.get("A1", "C1");
    expect(s?.nextCheckAt).toBe(900);
    expect(s?.failures).toBe(2);
    expect(s?.checklistHash).toBe("h2");
  });
  test("a settling run finds its channel, once", async () => {
    await S.noteStart("A1", "C1", "h", "run1", 100);
    expect(await S.channelOfRun("run1")).toBe("C1");
    await S.noteSettled("A1", "C1", { outcome: "ok", failures: 0, nextCheckAt: null }, 160);
    expect(await S.channelOfRun("run1")).toBeNull();
  });
  test("a new start replaces the open run", async () => {
    await S.noteStart("A1", "C1", "h", "run1", 100);
    await S.noteStart("A1", "C1", "h", "run2", 200);
    expect(await S.channelOfRun("run1")).toBeNull();
    expect(await S.channelOfRun("run2")).toBe("C1");
  });
  test("an unknown run has no channel", async () => {
    expect(await S.channelOfRun("nope")).toBeNull();
  });
});
