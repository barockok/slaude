/**
 * SessionStore seam: AgentManager persists sessions through the injected
 * store; the default store is the db repo (behavior unchanged).
 */
import { describe, expect, test } from "bun:test";
import { AgentManager } from "../../src/agent/manager";
import { dbSessionStore, type SessionStore, type SessionRow } from "../../src/agent/session-store";
import * as Sessions from "../../src/db/sessions";

function fakeRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "fake-1",
    created_at: 1,
    updated_at: 1,
    title: null,
    model: "m",
    working_dir: "/tmp/x",
    status: "idle",
    claude_started: 0,
    slack_team_id: "T1",
    slack_channel_id: "C1",
    slack_thread_ts: "1.0",
    permission_mode: "default",
    engaged: 1,
    persona_id: "default",
    ...over,
  };
}

function recordingStore(rows: Map<string, SessionRow>) {
  const calls: string[] = [];
  const store: SessionStore = {
    async findById(id) {
      calls.push(`findById:${id}`);
      return rows.get(id) ?? null;
    },
    async findByThread(k) {
      calls.push(`findByThread:${k.thread_ts}`);
      for (const r of rows.values()) {
        if (r.slack_thread_ts === k.thread_ts && r.slack_channel_id === k.channel_id) return r;
      }
      return null;
    },
    async createForThread(args) {
      calls.push(`createForThread:${args.thread.thread_ts}`);
      const row = fakeRow({
        id: `created-${args.thread.thread_ts}`,
        slack_team_id: args.thread.team_id,
        slack_channel_id: args.thread.channel_id,
        slack_thread_ts: args.thread.thread_ts,
        model: args.model,
        working_dir: args.working_dir,
      });
      rows.set(row.id, row);
      return row;
    },
    async markStarted(id) {
      calls.push(`markStarted:${id}`);
    },
    async clearStarted(id) {
      calls.push(`clearStarted:${id}`);
    },
    async setStatus(id, status) {
      calls.push(`setStatus:${id}:${status}`);
    },
    async setPermissionMode(id, mode) {
      calls.push(`setPermissionMode:${id}:${mode}`);
      const r = rows.get(id);
      if (r) r.permission_mode = mode;
    },
    async setModel(id, model) {
      calls.push(`setModel:${id}:${model}`);
      const r = rows.get(id);
      if (r) r.model = model;
    },
  };
  return { store, calls };
}

describe("AgentManager SessionStore seam", () => {
  test("ensureSession routes find/create through the injected store", async () => {
    const rows = new Map<string, SessionRow>();
    const { store, calls } = recordingStore(rows);
    const agent = new AgentManager();
    agent.setSessionStore(store);
    const thread = { team_id: "T1", channel_id: "C9", thread_ts: "42.0" };
    const row = await agent.ensureSession(thread);
    expect(row.id).toBe("created-42.0");
    expect(calls).toContain("findByThread:42.0");
    expect(calls).toContain("createForThread:42.0");
    // Second call finds the existing row, no create.
    const again = await agent.ensureSession(thread);
    expect(again.id).toBe(row.id);
    expect(calls.filter((c) => c.startsWith("createForThread")).length).toBe(1);
  });

  test("setPermissionMode / setSessionModel persist via the injected store", async () => {
    const rows = new Map<string, SessionRow>([["fake-1", fakeRow()]]);
    const { store, calls } = recordingStore(rows);
    const agent = new AgentManager();
    agent.setSessionStore(store);
    await agent.setPermissionMode("fake-1", "plan");
    await agent.setSessionModel("fake-1", "new-model");
    expect(calls).toContain("setPermissionMode:fake-1:plan");
    expect(calls).toContain("setModel:fake-1:new-model");
    expect(rows.get("fake-1")!.permission_mode).toBe("plan");
    expect(rows.get("fake-1")!.model).toBe("new-model");
  });

  test("setSessionStore(undefined) restores the db default", async () => {
    const agent = new AgentManager();
    const { store } = recordingStore(new Map());
    agent.setSessionStore(store);
    agent.setSessionStore(undefined);
    // db default: ensureSession hits the real repo and persists a row.
    const row = await agent.ensureSession({ team_id: "TSEAM", channel_id: "CSEAM", thread_ts: "77.0" });
    expect((await Sessions.findById(row.id))?.id).toBe(row.id);
  });

  test("dbSessionStore delegates to the sessions repo", async () => {
    const row = await dbSessionStore.createForThread({
      thread: { team_id: "TSEAM", channel_id: "CSEAM2", thread_ts: "78.0" },
      model: "m1",
      working_dir: "/tmp/seam",
    });
    expect((await dbSessionStore.findById(row.id))?.model).toBe("m1");
    await dbSessionStore.setModel(row.id, "m2");
    await dbSessionStore.setPermissionMode(row.id, "acceptEdits");
    await dbSessionStore.setStatus(row.id, "running");
    await dbSessionStore.markStarted(row.id);
    let cur = await dbSessionStore.findById(row.id);
    expect(cur?.model).toBe("m2");
    expect(cur?.permission_mode).toBe("acceptEdits");
    expect(cur?.status).toBe("running");
    expect(cur?.claude_started).toBe(1);
    await dbSessionStore.clearStarted(row.id);
    cur = await dbSessionStore.findById(row.id);
    expect(cur?.claude_started).toBe(0);
    expect((await dbSessionStore.findByThread({ team_id: "TSEAM", channel_id: "CSEAM2", thread_ts: "78.0" }))?.id).toBe(row.id);
  });
});
