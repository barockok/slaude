/**
 * GET /panel/api/labels (node labels spec §4.7): read-only, any authenticated
 * operator, the same guard as every other panel read.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createPanelApi } from "../../src/gateway/panel/api";
import { __resetRoleCache } from "../../src/gateway/panel/auth/roles";
import { mintSession, AT_COOKIE } from "../../src/gateway/panel/auth/session";
import type { LabelStatus } from "../../src/queue/label-status";

const SECRET = "t".repeat(32);
const cookie = (email: string) => `${AT_COOKIE}=${mintSession({ sub: "s", email }, "at", { secret: SECRET })}`;
const operator = cookie("alice@example.com");

const status: LabelStatus[] = [
  { label: "default", liveNodes: 2, waiting: 0, unserved: false, unservedSinceMs: null },
  { label: "finance", liveNodes: 0, waiting: 3, unserved: true, unservedSinceMs: 1 },
];
const mk = (labels?: (() => Promise<LabelStatus[]>) | null) =>
  createPanelApi({ registry: null, pubsub: null, panelLock: null, chat: async () => {}, labels });
const req = (method: string, who?: string) =>
  new Request("https://panel.example.com/panel/api/labels", {
    method,
    headers: { ...(who ? { cookie: who } : {}), ...(method === "GET" ? {} : { "x-panel-csrf": "1" }) },
  });

beforeEach(() => {
  process.env.SLAUDE_PANEL_SECRET = SECRET;
  process.env.SLAUDE_PANEL_SUPERADMIN = "lead@example.com";
  process.env.SLAUDE_PANEL_OPERATORS = "alice@example.com";
  __resetRoleCache();
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("SLAUDE_PANEL")) delete process.env[k];
  __resetRoleCache();
});

describe("GET /panel/api/labels", () => {
  test("an operator gets every label in use with live nodes, waiting and unserved", async () => {
    const res = (await mk(async () => status).fetch(req("GET", operator)))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { label: "default", liveNodes: 2, waiting: 0, unserved: false },
      { label: "finance", liveNodes: 0, waiting: 3, unserved: true },
    ]);
  });

  test("unauthenticated is refused", async () => {
    expect((await mk(async () => status).fetch(req("GET")))!.status).toBe(401);
  });

  test("read-only: other methods are refused", async () => {
    expect((await mk(async () => status).fetch(req("POST", operator)))!.status).toBe(405);
  });

  test("503 without a node queue (mono)", async () => {
    expect((await mk(null).fetch(req("GET", operator)))!.status).toBe(503);
  });
});
