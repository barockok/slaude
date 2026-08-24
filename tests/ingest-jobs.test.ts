import { describe, test, expect, beforeEach } from "bun:test";
import { db } from "../src/db/schema";
import { tryAcquire, release, heartbeat, runningJob, reapStale, STALE_AFTER_MS } from "../src/db/ingest-jobs";

beforeEach(async () => {
  await db.run("DELETE FROM kb_ingest_jobs");
});

describe("ingest-jobs", async () => {
  test("tryAcquire succeeds when no running job", async () => {
    const job = await tryAcquire("ops-wiki", "U123");
    expect(job).not.toBeNull();
    expect(job!.label).toBe("ops-wiki");
    expect(job!.status).toBe("running");
  });

  test("tryAcquire fails when one already running", async () => {
    await tryAcquire("ops-wiki", "U123");
    const second = await tryAcquire("ops-wiki", "U456");
    expect(second).toBeNull();
  });

  test("release frees the slot", async () => {
    const job = (await tryAcquire("ops-wiki", "U123"))!;
    await release(job.id, "completed");
    expect(await runningJob()).toBeNull();
    const next = await tryAcquire("ops-wiki", "U456");
    expect(next).not.toBeNull();
  });

  test("heartbeat advances heartbeat_at", async () => {
    const job = (await tryAcquire("ops-wiki", "U123"))!;
    const before = job.heartbeat_at;
    await new Promise((r) => setTimeout(r, 5));
    await heartbeat(job.id);
    const row = (await runningJob())!;
    expect(row.heartbeat_at).toBeGreaterThan(before);
  });

  test("reapStale releases jobs older than STALE_AFTER_MS", async () => {
    const job = (await tryAcquire("ops-wiki", "U123"))!;
    const past = Date.now() - STALE_AFTER_MS - 1000;
    await db.run("UPDATE kb_ingest_jobs SET heartbeat_at = ? WHERE id = ?", [past, job.id]);
    const reaped = await reapStale();
    expect(reaped).toEqual([job.id]);
    expect(await runningJob()).toBeNull();
  });
});
