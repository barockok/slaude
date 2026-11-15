import { expect, test } from "bun:test";
import { flushFirstSightWork, trackFirstSight } from "../../src/domain/first-sight-flush";

test("a flush waits for tracked work that settles", async () => {
  let done = false;
  trackFirstSight(new Promise<void>((r) => setTimeout(() => ((done = true), r()), 20)));
  await flushFirstSightWork();
  expect(done).toBe(true);
});

test("a flush gives up on work that never settles instead of hanging every later hook", async () => {
  trackFirstSight(new Promise<void>(() => {}));
  const t0 = Date.now();
  await flushFirstSightWork(60);
  expect(Date.now() - t0).toBeLessThan(1000);
  // the stuck entry was dropped: the next flush returns at once
  const t1 = Date.now();
  await flushFirstSightWork(60);
  expect(Date.now() - t1).toBeLessThan(30);
});
