import { describe, expect, test, beforeEach } from "bun:test";
import { db } from "../../src/db/schema";
import * as SeenEvents from "../../src/db/seen-events";

beforeEach(async () => {
  await db.run("DELETE FROM seen_events");
  SeenEvents.__resetPurgeClockForTests();
});

describe("seen-events repo", () => {
  test("tryInsert claims an id exactly once", async () => {
    expect(await SeenEvents.tryInsert("C1:1.0")).toBe(true);
    expect(await SeenEvents.tryInsert("C1:1.0")).toBe(false); // Slack retry → dropped
    expect(await SeenEvents.tryInsert("C1:2.0")).toBe(true); // different event ok
  });

  test("purgeOlderThan drops only stale rows", async () => {
    const now = Date.now();
    await SeenEvents.tryInsert("old", now - SeenEvents.MAX_AGE_MS - 1000);
    await SeenEvents.tryInsert("fresh", now);
    expect(await SeenEvents.purgeOlderThan(SeenEvents.MAX_AGE_MS, now)).toBe(1);
    expect(await SeenEvents.tryInsert("old", now)).toBe(true); // purged → reclaimable
    expect(await SeenEvents.tryInsert("fresh", now)).toBe(false); // survived
  });

  test("maybePurge runs at most once per interval", async () => {
    const now = Date.now();
    await SeenEvents.tryInsert("stale-a", now - SeenEvents.MAX_AGE_MS - 1000);
    await SeenEvents.maybePurge(now); // fires — clock was reset
    expect(await SeenEvents.tryInsert("stale-a", now - SeenEvents.MAX_AGE_MS - 1000)).toBe(true);
    await SeenEvents.maybePurge(now + 1000); // within interval — no purge
    expect(await SeenEvents.tryInsert("stale-a", now)).toBe(false); // still there
    await SeenEvents.maybePurge(now + 6 * 60 * 1000); // past interval — purges
    expect(await SeenEvents.tryInsert("stale-a", now)).toBe(true);
  });
});
