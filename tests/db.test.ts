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

const baseThread = (suffix: string) => ({
  team_id: "T" + suffix,
  channel_id: "C" + suffix,
  thread_ts: "1.0" + suffix,
});

describe("db/sessions", () => {
  test("create + find by thread/id", () => {
    const t = baseThread("a");
    expect(findByThread(t)).toBeNull();
    const row = createForThread({
      thread: t,
      model: "m",
      working_dir: "/tmp",
      title: "x",
    });
    expect(row.id).toBeTruthy();
    expect(row.permission_mode).toBe("default");
    expect(findById(row.id)?.id).toBe(row.id);
    expect(findByThread(t)?.id).toBe(row.id);
    expect(findById("does-not-exist")).toBeNull();
  });

  test("status / started flags", () => {
    const row = createForThread({
      thread: baseThread("b"),
      model: "m",
      working_dir: "/tmp",
    });
    markStarted(row.id);
    expect(findById(row.id)?.claude_started).toBe(1);
    setStatus(row.id, "running");
    expect(findById(row.id)?.status).toBe("running");
    clearStarted(row.id);
    expect(findById(row.id)?.claude_started).toBe(0);
    setPermissionMode(row.id, "bypassPermissions");
    expect(findById(row.id)?.permission_mode).toBe("bypassPermissions");
  });

  test("custom permission_mode at create", () => {
    const row = createForThread({
      thread: baseThread("c"),
      model: "m",
      working_dir: "/tmp",
      permission_mode: "plan",
    });
    expect(row.permission_mode).toBe("plan");
  });
});

test("kb_ingest_jobs table exists with expected columns", () => {
  const cols = db.query("PRAGMA table_info(kb_ingest_jobs)").all() as Array<{ name: string }>;
  const names = cols.map((c) => c.name).sort();
  expect(names).toEqual(["heartbeat_at", "id", "label", "started_at", "status", "triggered_by"].sort());
});
