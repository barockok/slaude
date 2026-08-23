/**
 * Generic REST round-trip: EVERY tool in EVERY contract is POSTed to
 * /v1/tools/<server>/<tool> over real HTTP with a minimal valid input. The
 * fixture map is completeness-checked in both directions against the
 * contracts, so adding a tool to a contract without REST-plane coverage (or
 * retiring one and leaving a stale fixture) fails this file — REST coverage
 * cannot lag the contract.
 *
 * Expected outcomes per tool: a 200 MCP-shaped result (optionally a
 * documented isError result), or 404 "not mounted" for tools the deployment
 * doesn't mount (surface capabilities, brain disabled — this file runs with
 * SLAUDE_BRAIN_DISABLED=1 so the kb brain tools stay hermetic; their handler
 * logic is covered by tests/brain-mcp-tools.test.ts and tests/kb-mcp-tools.test.ts).
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

process.env.SLAUDE_BRAIN_DISABLED = "1"; // before gateway import side effects run

import { createGateway, type GatewayHandle } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { soulData, setSoulData } from "../../../src/soul/extract";
import { mintJobToken, JOB_HEADER } from "../../../src/gateway/api/auth";
import { SERVERS } from "../../../src/gateway/api/tools";
import * as CronJobs from "../../../src/db/cron-jobs";
import { ensureHome, paths } from "../../../src/config/home";

const NODE_TOKEN = "roundtrip-node-token";
const JOB_SECRET = "roundtrip-job-secret";

function fakeTransport(): Transport {
  return {
    client: {
      auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
      chat: { postMessage: async () => ({ ok: true, ts: "1.1" }), update: async () => ({ ok: true }) },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      conversations: { info: async () => ({}), members: async () => ({ members: [] }), replies: async () => ({ messages: [] }) },
      users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
      search: { messages: async () => ({ messages: { matches: [], total: 0 } }) },
      files: { uploadV2: async () => ({ files: [] }) },
    } as any,
    action: () => {}, event: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
  };
}

type Fixture = {
  /** Minimal strict-valid input; a thunk when it depends on runtime state. */
  input: Record<string, unknown> | (() => Record<string, unknown>);
  /** "result" (default): expect 200 MCP-shaped. "not_mounted": expect 404. */
  expect?: "result" | "not_mounted";
  /** The 200 result is allowed (not required) to carry isError — documented
   *  degradation for this environment (missing file, dead session, …). */
  isErrorOk?: boolean;
};

let cronJobId = "";
let uploadPath = "";

const FIXTURES: Record<string, Record<string, Fixture>> = {
  surface: {
    reply: { input: { text: "roundtrip" } },
    get_history: { input: {} },
    request_approval: { input: { summary: "roundtrip approval" } }, // non-blocking: returns {pendingId} (spec §3)
    edit: { input: { ref: "1.1", text: "edited" } },
    react: { input: { name: "eyes" } },
    unreact: { input: { name: "eyes" } },
    upload: { input: () => ({ path: uploadPath }) },
    typing: { input: { on: true }, expect: "not_mounted" }, // SlackSurface has no "typing" capability
    set_one_on_one: { input: { action: "off" } },
    set_mention_only: { input: { active: false } },
    soul_override: { input: { field: "trust", action: "list" } },
  },
  slack: {
    reply: { input: { text: "roundtrip legacy" } },
    get_user_profile: { input: { user_id: "U0OTHER" } },
    get_channel_info: { input: {} },
    list_users_in_channel: { input: {} },
    search_messages: { input: { query: "roundtrip" } },
  },
  runtime: {
    ignore_thread: { input: { duration: "5m", reason: "roundtrip" } },
    unignore_thread: { input: {} },
    ignore_user: { input: { user_id: "U0NOISY", duration: "5m", reason: "roundtrip" } },
    unignore_user: { input: { user_id: "U0NOISY" } },
    list_cron_jobs: { input: {} },
    add_cron_job: { input: { cron_expr: "0 9 * * *", prompt: "roundtrip job" } },
    edit_cron_job: { input: () => ({ job_id: cronJobId, prompt: "edited" }) },
    pause_cron_job: { input: () => ({ job_id: cronJobId }) },
    resume_cron_job: { input: () => ({ job_id: cronJobId }) },
    remove_cron_job: { input: () => ({ job_id: cronJobId }) },
    trigger_ingest: { input: {}, isErrorOk: true }, // no slaude.json in the test home
    reload_session: { input: {}, isErrorOk: true }, // session not live in this process
    can_use_tool: { input: { tool_name: "Bash", input: { command: "ls" }, tool_use_id: "rt_perm_fixture" } }, // REST-only: returns {pendingId}
  },
  connect: {
    connect_mcp: { input: { server: "nonexistent" } }, // manager scope → "unknown MCP server" text
  },
  skills: {
    write_skill: { input: { slug: "roundtrip", name: "Roundtrip", description: "rt", body: "Say hi.\n" } },
    list_skills: { input: {} },
    read_skill: { input: { slug: "roundtrip" } },
    delete_skill: { input: { slug: "roundtrip" } },
    sync_manifest: { input: {}, isErrorOk: true }, // no manifest in the test home
  },
  kb: {
    list_kbs: { input: {} },
    search_kbs: { input: { query: "roundtrip" } },
    kb_think: { input: { question: "q" }, expect: "not_mounted" },
    kb_search: { input: { query: "q" }, expect: "not_mounted" },
    kb_get_page: { input: { slug: "s" }, expect: "not_mounted" },
    kb_list_pages: { input: {}, expect: "not_mounted" },
    kb_graph: { input: { slug: "s" }, expect: "not_mounted" },
    kb_memoize: { input: { pages: [{ slug: "s", content: "c", summary: "m" }] }, expect: "not_mounted" },
    kb_delete_page: { input: { slug: "s", reason: "r" }, expect: "not_mounted" },
  },
};

let handle: GatewayHandle;
let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(async () => {
  process.env.SLAUDE_NODE_TOKEN = NODE_TOKEN;
  process.env.SLAUDE_JOB_SECRET = JOB_SECRET;
  ensureHome();
  writeSoulFixture(WORLD);
  // request_approval must settle inside the test: 1s auto-deny.
  setSoulData({ ...soulData(), approvalTimeoutSeconds: 1 });
  uploadPath = join(paths.workspaces, "roundtrip-upload.txt");
  writeFileSync(uploadPath, "roundtrip\n");
  const job = await CronJobs.create({
    slackTeamId: "T1",
    slackChannelId: "C0TEAM",
    slackThreadTs: "300.0",
    channelId: "C0TEAM",
    threadTs: "300.0",
    createdBy: WORLD.manager,
    cronExpr: "0 8 * * *",
    prompt: "roundtrip fixture job",
    nextRunAt: Date.now() + 3600_000,
  });
  cronJobId = job.id.slice(0, 8);
  handle = createGateway(new AgentManager(), fakeTransport());
  server = Bun.serve({
    port: 0,
    fetch: async (req) => (await handle.fetchV1(req)) ?? new Response("not found", { status: 404 }),
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  delete process.env.SLAUDE_NODE_TOKEN;
  delete process.env.SLAUDE_JOB_SECRET;
  delete process.env.SLAUDE_BRAIN_DISABLED;
});

describe("fixture map completeness", () => {
  for (const [name, { contract }] of Object.entries(SERVERS)) {
    test(`${name}: fixtures cover the contract exactly`, () => {
      expect(Object.keys(FIXTURES[name] ?? {}).sort()).toEqual(Object.keys(contract.tools).sort());
    });
  }
  test("fixtures name no unknown servers", () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(Object.keys(SERVERS).sort());
  });
});

describe("every contract tool round-trips over REST", () => {
  for (const [serverName, tools] of Object.entries(FIXTURES)) {
    for (const [toolName, fx] of Object.entries(tools)) {
      test(`${serverName}/${toolName}`, async () => {
        const input = typeof fx.input === "function" ? fx.input() : fx.input;
        const token = mintJobToken({
          tenant: "default",
          persona: "default",
          session: "S-roundtrip",
          team: "T1",
          channel: "C0TEAM",
          thread: "300.0",
          initiator: WORLD.manager,
          scope: "turn",
        });
        const r = await fetch(`${base}/v1/tools/${serverName}/${toolName}`, {
          method: "POST",
          headers: { authorization: `Bearer ${NODE_TOKEN}`, [JOB_HEADER]: token },
          body: JSON.stringify(input),
        });
        if (fx.expect === "not_mounted") {
          expect(r.status).toBe(404);
          expect(((await r.json()) as any).error).toContain("not mounted");
          return;
        }
        expect(r.status).toBe(200);
        const body = (await r.json()) as any;
        expect(Array.isArray(body.content)).toBe(true);
        expect(body.content.length).toBeGreaterThan(0);
        for (const item of body.content) {
          expect(item.type).toBe("text");
          expect(typeof item.text).toBe("string");
        }
        if (!fx.isErrorOk) {
          expect(body.isError).not.toBe(true);
        }
      }, 15_000);
    }
  }
});
