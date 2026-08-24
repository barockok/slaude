import { describe, expect, test } from "bun:test";
import {
  createForThread,
  findById,
  findByThread,
  markStarted,
  setStatus,
  clearStarted,
  setPermissionMode,
} from "../src/db/sessions";
import { db } from "../src/db/schema";
import { getSqliteRaw } from "../src/db/client";

const baseThread = (suffix: string) => ({
  team_id: "T" + suffix,
  channel_id: "C" + suffix,
  thread_ts: "1.0" + suffix,
});

describe("db/sessions", () => {
  test("create + find by thread/id", async () => {
    const t = baseThread("a");
    expect(await findByThread(t)).toBeNull();
    const row = await createForThread({
      thread: t,
      model: "m",
      working_dir: "/tmp",
      title: "x",
    });
    expect(row.id).toBeTruthy();
    expect(row.permission_mode).toBe("default");
    expect((await findById(row.id))?.id).toBe(row.id);
    expect((await findByThread(t))?.id).toBe(row.id);
    expect(await findById("does-not-exist")).toBeNull();
  });

  test("status / started flags", async () => {
    const row = await createForThread({
      thread: baseThread("b"),
      model: "m",
      working_dir: "/tmp",
    });
    await markStarted(row.id);
    expect((await findById(row.id))?.claude_started).toBe(1);
    await setStatus(row.id, "running");
    expect((await findById(row.id))?.status).toBe("running");
    await clearStarted(row.id);
    expect((await findById(row.id))?.claude_started).toBe(0);
    await setPermissionMode(row.id, "bypassPermissions");
    expect((await findById(row.id))?.permission_mode).toBe("bypassPermissions");
  });

  test("custom permission_mode at create", async () => {
    const row = await createForThread({
      thread: baseThread("c"),
      model: "m",
      working_dir: "/tmp",
      permission_mode: "plan",
    });
    expect(row.permission_mode).toBe("plan");
  });
});

test("kb_ingest_jobs table exists with expected columns", async () => {
  // Touch the facade first so pg applies migrations before we inspect the table.
  await db.query("SELECT 1 AS one");
  const raw = getSqliteRaw();
  let names: string[];
  if (raw) {
    const cols = raw.query("PRAGMA table_info(kb_ingest_jobs)").all() as Array<{ name: string }>;
    names = cols.map((c) => c.name);
  } else {
    const cols = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = ?",
      ["kb_ingest_jobs"],
    );
    names = cols.map((c) => c.column_name);
  }
  const expected = ["heartbeat_at", "id", "label", "started_at", "status", "triggered_by"].sort();
  // pg migrations add a tenant_id column that sqlite does not carry.
  const observed = names.filter((n) => n !== "tenant_id").sort();
  expect(observed).toEqual(expected);
});
