/**
 * RestSessionStore ↔ dbSessionStore parity against a live /v1 (real gateway
 * router over Bun.serve, sqlite db): reads return the same row, writes land
 * in the same store the db repo reads.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

process.env.SLAUDE_BRAIN_DISABLED = "1";

import { createGateway, type GatewayHandle } from "../../src/gateway/core/gateway";
import { AgentManager } from "../../src/agent/manager";
import type { Transport } from "../../src/gateway/core/transport";
import { mintJobToken } from "../../src/gateway/api/auth";
import { dbSessionStore } from "../../src/agent/session-store";
import { NodeClient } from "../../src/node/client";
import { RestSessionStore } from "../../src/node/session-store";
import { ensureHome } from "../../src/config/home";

const NODE_TOKEN = "rest-store-node-token";
const JOB_SECRET = "rest-store-job-secret";

function fakeTransport(): Transport {
  return {
    client: {
      auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
      chat: { postMessage: async () => ({ ok: true, ts: "1.1" }), update: async () => ({ ok: true }) },
    } as any,
    action: () => {}, event: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
  };
}

let handle: GatewayHandle;
let server: ReturnType<typeof Bun.serve>;
let store: RestSessionStore;
let sessionId = "";

beforeAll(async () => {
  process.env.SLAUDE_NODE_TOKEN = NODE_TOKEN;
  process.env.SLAUDE_JOB_SECRET = JOB_SECRET;
  ensureHome();
  handle = createGateway(new AgentManager(), fakeTransport());
  server = Bun.serve({
    port: 0,
    fetch: async (req) => (await handle.fetchV1(req)) ?? new Response("nf", { status: 404 }),
  });
  const row = await dbSessionStore.createForThread({
    thread: { team_id: "T1", channel_id: "C0STORE", thread_ts: "500.0" },
    model: "store-model",
    working_dir: "/tmp/store-wd",
  });
  sessionId = row.id;
  store = new RestSessionStore(new NodeClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: NODE_TOKEN, baseDelayMs: 1 }));
  store.bindToken(
    sessionId,
    mintJobToken({
      tenant: "default", persona: "default", session: sessionId,
      team: "T1", channel: "C0STORE", thread: "500.0", initiator: "U1", scope: "turn",
    }),
  );
});

afterAll(() => {
  server?.stop(true);
  delete process.env.SLAUDE_NODE_TOKEN;
  delete process.env.SLAUDE_JOB_SECRET;
  delete process.env.SLAUDE_BRAIN_DISABLED;
});

describe("RestSessionStore over live /v1", () => {
  test("findById returns the same row shape as the db store", async () => {
    const viaRest = await store.findById(sessionId);
    const viaDb = await dbSessionStore.findById(sessionId);
    expect(viaRest).toEqual(viaDb);
  });

  test("writes land in the shared store", async () => {
    await store.setModel(sessionId, "rest-model");
    await store.setPermissionMode(sessionId, "acceptEdits");
    await store.setStatus(sessionId, "running");
    await store.markStarted(sessionId);
    let db = await dbSessionStore.findById(sessionId);
    expect(db?.model).toBe("rest-model");
    expect(db?.permission_mode).toBe("acceptEdits");
    expect(db?.status).toBe("running");
    expect(db?.claude_started).toBe(1);
    await store.clearStarted(sessionId);
    db = await dbSessionStore.findById(sessionId);
    expect(db?.claude_started).toBe(0);
    // Round-trip parity after writes.
    expect(await store.findById(sessionId)).toEqual(db);
  });

  test("unknown session → null; unbound session → loud error", async () => {
    const ghost = "00000000-0000-0000-0000-00000000dead";
    store.bindToken(ghost, mintJobToken({
      tenant: "default", persona: "default", session: ghost,
      team: "T1", channel: "C0STORE", thread: "500.0", initiator: "U1", scope: "turn",
    }));
    expect(await store.findById(ghost)).toBeNull();
    await expect(store.findById("never-bound")).rejects.toThrow("no job token bound");
  });

  test("gateway-only surface throws", async () => {
    await expect(store.findByThread({ team_id: "T1", channel_id: "C", thread_ts: "1.0" })).rejects.toThrow("gateway-only");
    await expect(
      store.createForThread({ thread: { team_id: "T1", channel_id: "C", thread_ts: "1.0" }, model: "m", working_dir: "/tmp" }),
    ).rejects.toThrow("gateway-only");
  });
});
