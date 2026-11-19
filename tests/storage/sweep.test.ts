import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ObjectInfo, ObjectStore, PutBody } from "../../src/storage";
import { runStorageSweep } from "../../src/gateway/core/storage-sweeper";
import { sweepInbox, sweepUnits } from "../../src/storage/sweep";
import { storageSweepConfig } from "../../src/storage/config";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 19);

/** An in-memory store whose objects carry a chosen modified time (or none). */
class MemStore implements ObjectStore {
  readonly objs = new Map<string, { modified?: number }>();
  deleted: string[] = [];
  add(key: string, ageMs: number | null): this {
    this.objs.set(key, ageMs === null ? {} : { modified: NOW - ageMs });
    return this;
  }
  async get(): Promise<null> {
    return null;
  }
  async put(_k: string, _b: PutBody): Promise<{ etag: string }> {
    return { etag: "x" };
  }
  async head(): Promise<null> {
    return null;
  }
  async *list(prefix: string): AsyncIterable<ObjectInfo> {
    for (const k of [...this.objs.keys()].sort()) {
      if (!k.startsWith(prefix)) continue;
      const o = this.objs.get(k)!;
      yield { key: k, size: 1, etag: "x", ...(o.modified !== undefined ? { modified: o.modified } : {}) };
    }
  }
  async delete(keys: string[]): Promise<void> {
    for (const k of keys) {
      this.objs.delete(k);
      this.deleted.push(k);
    }
  }
  keys(): string[] {
    return [...this.objs.keys()].sort();
  }
}

describe("sweepUnits", () => {
  test("a unit whose newest object is older than retention goes whole, manifests and blobs together", async () => {
    const s = new MemStore()
      .add("sessions/ws-old/manifest/0000000001-000001.json", 100 * DAY)
      .add("sessions/ws-old/blobs/aaa", 120 * DAY)
      .add("sessions/ws-young/manifest/0000000001-000001.json", 2 * DAY);
    const r = await sweepUnits(s, { retainMs: 90 * DAY, now: NOW });
    expect(r).toEqual({ unitsDeleted: ["ws-old"], unitsKept: 1, objectsDeleted: 2 });
    expect(s.keys()).toEqual(["sessions/ws-young/manifest/0000000001-000001.json"]);
  });

  test("one recent object keeps the whole unit, even when everything else in it is old", async () => {
    const s = new MemStore().add("sessions/ws-a/blobs/old", 400 * DAY).add("sessions/ws-a/manifest/0000000009-000001.json", 1 * DAY);
    const r = await sweepUnits(s, { retainMs: 90 * DAY, now: NOW });
    expect(r.unitsDeleted).toEqual([]);
    expect(s.keys()).toHaveLength(2);
  });

  test("a unit with an object that reports no modified time is never deleted: its age is unknown", async () => {
    const s = new MemStore().add("sessions/ws-unknown/blobs/a", 500 * DAY).add("sessions/ws-unknown/blobs/b", null);
    const r = await sweepUnits(s, { retainMs: 90 * DAY, now: NOW });
    expect(r.unitsDeleted).toEqual([]);
    expect(s.keys()).toHaveLength(2);
  });

  test("a unit the caller says to skip (a pending flush) is kept however old", async () => {
    const s = new MemStore().add("sessions/ws-pending/blobs/a", 500 * DAY).add("sessions/ws-gone/blobs/a", 500 * DAY);
    const r = await sweepUnits(s, { retainMs: 90 * DAY, now: NOW, skip: async (u) => u === "ws-pending" });
    expect(r.unitsDeleted).toEqual(["ws-gone"]);
    expect(s.keys()).toEqual(["sessions/ws-pending/blobs/a"]);
  });

  test("dry run reports exactly what would go and deletes nothing", async () => {
    const s = new MemStore().add("sessions/ws-old/blobs/a", 500 * DAY).add("sessions/ws-old/blobs/b", 500 * DAY);
    const r = await sweepUnits(s, { retainMs: 90 * DAY, now: NOW, dryRun: true });
    expect(r).toEqual({ unitsDeleted: ["ws-old"], unitsKept: 0, objectsDeleted: 2 });
    expect(s.deleted).toEqual([]);
    expect(s.keys()).toHaveLength(2);
  });

  test("unit names that share a prefix stay separate units, and other prefixes are never touched", async () => {
    const s = new MemStore()
      .add("sessions/ws-a/blobs/x", 500 * DAY)
      .add("sessions/ws-ab/blobs/x", 1 * DAY)
      .add("shared/skills/global/s/1/SKILL.md", 900 * DAY)
      .add("inbox/ws-a/file.txt", 900 * DAY);
    const r = await sweepUnits(s, { retainMs: 90 * DAY, now: NOW });
    expect(r.unitsDeleted).toEqual(["ws-a"]);
    expect(s.keys()).toEqual(["inbox/ws-a/file.txt", "sessions/ws-ab/blobs/x", "shared/skills/global/s/1/SKILL.md"]);
  });

  test("an empty store is a no-op", async () => {
    expect(await sweepUnits(new MemStore(), { retainMs: DAY, now: NOW })).toEqual({ unitsDeleted: [], unitsKept: 0, objectsDeleted: 0 });
  });
});

describe("sweepInbox", () => {
  test("deletes uncollected objects older than the ttl; one exactly at the ttl, a younger one and one with no time are kept", async () => {
    const TTL = 7 * DAY;
    const s = new MemStore()
      .add("inbox/ws-a/old.txt", TTL + 1)
      .add("inbox/ws-a/edge.txt", TTL)
      .add("inbox/ws-a/new.txt", 1000)
      .add("inbox/ws-b/unknown.txt", null)
      .add("sessions/ws-a/blobs/x", 999 * DAY);
    const r = await sweepInbox(s, { ttlMs: TTL, now: NOW });
    expect(r).toEqual({ objectsDeleted: 1 });
    expect(s.keys()).toEqual(["inbox/ws-a/edge.txt", "inbox/ws-a/new.txt", "inbox/ws-b/unknown.txt", "sessions/ws-a/blobs/x"]);
  });

  test("dry run deletes nothing", async () => {
    const s = new MemStore().add("inbox/ws-a/old.txt", 30 * DAY);
    expect(await sweepInbox(s, { ttlMs: DAY, now: NOW, dryRun: true })).toEqual({ objectsDeleted: 1 });
    expect(s.keys()).toHaveLength(1);
  });
});

describe("storageSweepConfig", () => {
  test("defaults to off with 90 days and 168 hours", () => {
    expect(storageSweepConfig({})).toEqual({ mode: "off", retainMs: 90 * DAY, inboxTtlMs: 168 * 3_600_000 });
  });
  test("on and dry-run are read, with the windows", () => {
    expect(storageSweepConfig({ SLAUDE_STORAGE_SWEEP: "on", SLAUDE_STORAGE_RETAIN_DAYS: "30", SLAUDE_STORAGE_INBOX_TTL_HOURS: "24" })).toEqual({
      mode: "on",
      retainMs: 30 * DAY,
      inboxTtlMs: 24 * 3_600_000,
    });
    expect(storageSweepConfig({ SLAUDE_STORAGE_SWEEP: "Dry-Run" }).mode).toBe("dry-run");
  });
  test("a typo never turns deletion on: an invalid mode is off, an invalid window is the default", () => {
    expect(storageSweepConfig({ SLAUDE_STORAGE_SWEEP: "yes" }).mode).toBe("off");
    expect(storageSweepConfig({ SLAUDE_STORAGE_SWEEP: "on", SLAUDE_STORAGE_RETAIN_DAYS: "-3" }).retainMs).toBe(90 * DAY);
    expect(storageSweepConfig({ SLAUDE_STORAGE_SWEEP: "on", SLAUDE_STORAGE_RETAIN_DAYS: "abc" }).retainMs).toBe(90 * DAY);
    expect(storageSweepConfig({ SLAUDE_STORAGE_SWEEP: "on", SLAUDE_STORAGE_INBOX_TTL_HOURS: "0" }).inboxTtlMs).toBe(168 * 3_600_000);
  });
});

/** The Redis commands the sweeper uses: SET NX PX (the lock), the compare-owner release (EVAL), and GET (marks). */
const lockTtls: number[] = [];
const fakeRedis = (held: Set<string> = new Set(), marks: Set<string> = new Set()) =>
  ({
    set: async (k: string, _v: string, _px: string, ttl: number, _nx: string) => {
      if (held.has(k)) return null;
      lockTtls.push(ttl);
      held.add(k);
      return "OK";
    },
    eval: async (_script: string, _n: number, key: string) => (held.delete(key) ? 1 : 0),
    get: async (k: string) => (marks.has(k) ? "{}" : null),
  }) as never;
const keys = { storageSweepLock: () => "lock:sweep", needsFlush: (u: string) => `flush:${u}`, fsInUse: (u: string) => `inuse:${u}` } as never;

describe("runStorageSweep", () => {
  test("mode off lists and deletes nothing", async () => {
    const s = new MemStore().add("sessions/ws-a/blobs/x", 500 * DAY);
    expect(await runStorageSweep({ store: s, redis: fakeRedis(), keys, cfg: { mode: "off", retainMs: DAY, inboxTtlMs: DAY }, now: NOW })).toBeNull();
    expect(s.keys()).toHaveLength(1);
  });

  test("a held lock means this replica does not sweep", async () => {
    const s = new MemStore().add("sessions/ws-a/blobs/x", 500 * DAY);
    const r = await runStorageSweep({ store: s, redis: fakeRedis(new Set(["lock:sweep"])), keys, cfg: { mode: "on", retainMs: DAY, inboxTtlMs: DAY }, now: NOW });
    expect(r).toBeNull();
    expect(s.keys()).toHaveLength(1);
  });

  test("on: sweeps old units and inbox objects, but never a unit with a pending flush mark", async () => {
    const s = new MemStore()
      .add("sessions/ws-gone/blobs/x", 500 * DAY)
      .add("sessions/ws-pending/blobs/x", 500 * DAY)
      .add("inbox/ws-gone/f", 500 * DAY);
    const r = await runStorageSweep({
      store: s,
      redis: fakeRedis(new Set(), new Set(["flush:ws-pending"])),
      keys,
      cfg: { mode: "on", retainMs: 90 * DAY, inboxTtlMs: 7 * DAY },
      now: NOW,
    });
    expect(r?.units.unitsDeleted).toEqual(["ws-gone"]);
    expect(r?.inbox.objectsDeleted).toBe(1);
    expect(s.keys()).toEqual(["sessions/ws-pending/blobs/x"]);
  });

  test("the lock is held for one hour less than the interval, so a replica's own next tick is never blocked by it", async () => {
    lockTtls.length = 0;
    const s = new MemStore();
    await runStorageSweep({ store: s, redis: fakeRedis(), keys, cfg: { mode: "on", retainMs: DAY, inboxTtlMs: DAY }, now: NOW });
    expect(lockTtls).toEqual([DAY - 3_600_000]);
  });

  test("a dry run releases the lock, so switching to on is not blocked for a day", async () => {
    const held = new Set<string>();
    const s = new MemStore().add("sessions/ws-gone/blobs/x", 500 * DAY);
    const redis = fakeRedis(held);
    const dry = await runStorageSweep({ store: s, redis, keys, cfg: { mode: "dry-run", retainMs: 90 * DAY, inboxTtlMs: DAY }, now: NOW });
    expect(dry?.units.unitsDeleted).toEqual(["ws-gone"]);
    expect(held.size).toBe(0);
    const real = await runStorageSweep({ store: s, redis, keys, cfg: { mode: "on", retainMs: 90 * DAY, inboxTtlMs: DAY }, now: NOW });
    expect(real?.units.unitsDeleted).toEqual(["ws-gone"]);
    expect(s.keys()).toEqual([]);
  });

  test("dry-run deletes nothing but still reports", async () => {
    const s = new MemStore().add("sessions/ws-gone/blobs/x", 500 * DAY);
    const r = await runStorageSweep({ store: s, redis: fakeRedis(), keys, cfg: { mode: "dry-run", retainMs: 90 * DAY, inboxTtlMs: DAY }, now: NOW });
    expect(r?.units.unitsDeleted).toEqual(["ws-gone"]);
    expect(s.keys()).toHaveLength(1);
  });
});

describe("gateway wiring", () => {
  test("the gateway starts the sweeper only with the object store, and stops it on shutdown", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/gateway/core/gateway.ts"), "utf8");
    expect(src).toContain("startStorageSweeper(");
    expect(src).toContain("stopStorageSweeper()");
    const start = src.indexOf("startStorageSweeper(");
    const block = src.slice(Math.max(0, start - 600), start);
    expect(block).toContain('storageMode() === "s3"');
  });
  test("the unit remover is named for what it takes: a unit id, not a session id", () => {
    const gc = readFileSync(join(import.meta.dir, "../../src/storage/gc.ts"), "utf8");
    expect(gc).not.toContain("removeSession");
    expect(gc).toContain("export async function removeUnit(");
  });
});
