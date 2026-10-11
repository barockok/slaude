/**
 * The cron scheduler's poll loop must not outlive its owner or crash on a
 * failed poll.
 *
 * Every createGateway() starts a CronScheduler: an immediate poll plus a 60s
 * setInterval against the process-wide DB facade. Many tests never stop their
 * gateway, so those intervals kept polling for the rest of the run. One fired
 * while tests/db/facade.test.ts had pointed the facade at a deliberately
 * unmigrated PGLite, and the poll's rejection (`relation "cron_jobs" does not
 * exist`) was unhandled — failing whichever test was running. In production
 * the same unhandled rejection on a DB blip takes the process down.
 */
import { describe, expect, spyOn, test } from "bun:test";
import * as CronJobs from "../src/db/cron-jobs";
import { CronScheduler } from "../src/gateway/slack/cron-scheduler";
import { runningLoops, stopRunningLoops } from "../src/gateway/core/running-loops";

const agent = { ensureSession: () => ({ id: "t" }), sendMessage: async () => {}, isLive: () => false, on: () => {}, off: () => {} } as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("CronScheduler lifecycle", () => {
  test("a poll that fails is logged, not left as an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => void unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    const find = spyOn(CronJobs, "findDue").mockRejectedValue(new Error('relation "cron_jobs" does not exist'));
    const err = spyOn(console, "error").mockImplementation(() => {});
    const s = new CronScheduler({ agent });
    try {
      s.start(); // immediate poll
      await sleep(20);
      expect(find).toHaveBeenCalled();
      expect(unhandled).toEqual([]);
      expect(err.mock.calls.some((c) => String(c[0]).includes("[cron] poll failed"))).toBe(true);
    } finally {
      s.stop();
      find.mockRestore();
      err.mockRestore();
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("a started scheduler is a running loop until stopped", () => {
    const find = spyOn(CronJobs, "findDue").mockResolvedValue([]);
    const s = new CronScheduler({ agent });
    try {
      const before = runningLoops();
      s.start();
      expect(runningLoops()).toBe(before + 1);
      s.stop();
      expect(runningLoops()).toBe(before);
    } finally {
      s.stop();
      find.mockRestore();
    }
  });

  test("stopRunningLoops() stops a scheduler whose owner never did", async () => {
    const find = spyOn(CronJobs, "findDue").mockResolvedValue([]);
    const s = new CronScheduler({ agent });
    try {
      s.start();
      stopRunningLoops();
      expect(runningLoops()).toBe(0);
      const calls = find.mock.calls.length;
      s.start(); // a stopped scheduler can be started again
      expect(find.mock.calls.length).toBe(calls + 1);
    } finally {
      s.stop();
      find.mockRestore();
    }
  });
});

// The shared teardown in tests/setup.ts: a loop left running by one test is
// stopped after it, so it cannot poll into the next test or file.
describe("setup teardown", () => {
  test("(part 1) leave a scheduler running", () => {
    const find = spyOn(CronJobs, "findDue").mockResolvedValue([]);
    try {
      new CronScheduler({ agent }).start();
      expect(runningLoops()).toBe(1);
    } finally {
      find.mockRestore();
    }
  });
  test("(part 2) nothing from the previous test is still running", () => {
    expect(runningLoops()).toBe(0);
  });
});
