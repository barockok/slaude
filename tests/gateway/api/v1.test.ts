/**
 * Integration tests for the node-facing REST /v1 (spec §3), served over real
 * HTTP on a random port by an in-process createGateway — the same wiring
 * src/server.ts mounts on the health server.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { createGateway, type GatewayHandle } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { mintJobToken, JOB_HEADER, type JobClaims } from "../../../src/gateway/api/auth";
import { db } from "../../../src/db/schema";
import * as Sessions from "../../../src/db/sessions";
import * as CronJobs from "../../../src/db/cron-jobs";
import { adminHandlers, slackHandlers, type SlackContext } from "../../../src/gateway/slack/mcp-tools";
import { skillHandlers, skillOps } from "../../../src/skills/mcp-tools";
import { kbHandlers } from "../../../src/knowledge/mcp-tools";
import { paths, ensureHome } from "../../../src/config/home";
import { __setRuleBrainCall } from "../../../src/proactive/rule-tool";
import { backgroundAgentId } from "../../../src/background/skill-check";
import { agentSourceId } from "../../../src/knowledge/scope";
import { readPageRecord } from "../../../src/knowledge/memory-pages";
import { fakeBrain } from "../../memory/fake-brain";
import { existsSync, mkdirSync, rmSync } from "node:fs";

const NODE_TOKEN = "test-node-token";
const JOB_SECRET = "test-job-secret";

function capturingTransport(): { t: Transport; posts: any[] } {
  const posts: any[] = [];
  const t: Transport = {
    client: {
      auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
      chat: { postMessage: async (a: any) => { posts.push(a); return { ok: true, ts: "1.1" }; }, update: async () => ({ ok: true }) },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
      users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
      search: { messages: async () => ({}) },
    } as any,
    action: () => {}, event: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
  };
  return { t, posts };
}

let handle: GatewayHandle;
let posts: any[];
let server: ReturnType<typeof Bun.serve>;
let base: string;
let sessionId: string;

const claimsFor = (session: string): Omit<JobClaims, "exp" | "iat"> => ({
  tenant: "default",
  persona: "default",
  session,
  team: "T1",
  channel: "C0TEAM",
  thread: "100.0",
  initiator: WORLD.manager,
  scope: "turn",
});

const jobToken = (session: string = sessionId) => mintJobToken(claimsFor(session));

const call = (path: string, init: RequestInit = {}, opts: { job?: string | null } = {}) => {
  const headers: Record<string, string> = {
    authorization: `Bearer ${NODE_TOKEN}`,
    ...(init.headers as Record<string, string> | undefined),
  };
  if (opts.job !== null) headers[JOB_HEADER] = opts.job ?? jobToken();
  return fetch(`${base}${path}`, { ...init, headers });
};

beforeAll(async () => {
  process.env.SLAUDE_NODE_TOKEN = NODE_TOKEN;
  process.env.SLAUDE_JOB_SECRET = JOB_SECRET;
  ensureHome();
  writeSoulFixture(WORLD);
  const cap = capturingTransport();
  posts = cap.posts;
  const agent = new AgentManager();
  handle = createGateway(agent, cap.t);
  server = Bun.serve({
    port: 0,
    fetch: async (req) => (await handle.fetchV1(req)) ?? new Response("not found", { status: 404 }),
  });
  base = `http://127.0.0.1:${server.port}`;
  const row = await Sessions.createForThread({
    thread: { team_id: "T1", channel_id: "C0TEAM", thread_ts: "100.0" },
    model: "test-model",
    working_dir: "/tmp/wd",
  });
  sessionId = row.id;
});

afterAll(() => {
  server?.stop(true);
  delete process.env.SLAUDE_NODE_TOKEN;
  delete process.env.SLAUDE_JOB_SECRET;
});

describe("/v1 auth", () => {
  test("missing bearer → 401; wrong bearer → 401", async () => {
    const r1 = await fetch(`${base}/v1/pending/nope`);
    expect(r1.status).toBe(401);
    const r2 = await fetch(`${base}/v1/pending/nope`, { headers: { authorization: "Bearer wrong" } });
    expect(r2.status).toBe(401);
  });

  test("unknown /v1 path → 404; wrong method → 405", async () => {
    expect((await call("/v1/nope", {}, { job: null })).status).toBe(404);
    expect((await call(`/v1/pending/x`, { method: "POST" }, { job: null })).status).toBe(405);
  });

  test("session + tool endpoints demand a job token", async () => {
    expect((await call(`/v1/sessions/${sessionId}`, {}, { job: null })).status).toBe(401);
    const expired = mintJobToken(claimsFor(sessionId), { ttlSec: -10 });
    expect((await call(`/v1/sessions/${sessionId}`, {}, { job: expired })).status).toBe(401);
    const tampered = jobToken() + "x";
    expect(
      (await call(`/v1/tools/kb/search_kbs`, { method: "POST", body: JSON.stringify({ query: "x" }) }, { job: tampered })).status,
    ).toBe(401);
  });
});

describe("/v1/sessions/:id", () => {
  test("GET returns the session row view", async () => {
    const r = await call(`/v1/sessions/${sessionId}`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body).toMatchObject({
      id: sessionId,
      model: "test-model",
      working_dir: "/tmp/wd",
      permission_mode: "default",
      persona_id: "default",
      engaged: 1,
      claude_started: 0,
      status: "idle",
    });
    // Full-row parity fields for the node REST SessionStore.
    expect(body.slack_team_id).toBe("T1");
    expect(body.slack_channel_id).toBe("C0TEAM");
    expect(typeof body.slack_thread_ts).toBe("string");
    expect(typeof body.created_at).toBe("number");
    expect(typeof body.updated_at).toBe("number");
  });

  test("PATCH updates claude_started, model, permission_mode", async () => {
    const r = await call(`/v1/sessions/${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify({ claude_started: true, model: "other-model", permission_mode: "acceptEdits" }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.claude_started).toBe(1);
    expect(body.model).toBe("other-model");
    expect(body.permission_mode).toBe("acceptEdits");
    const row = await Sessions.findById(sessionId);
    expect(row!.model).toBe("other-model");
    // revert for later tests
    await call(`/v1/sessions/${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify({ claude_started: 0, model: "test-model", permission_mode: "default" }),
    });
  });

  test("PATCH rejects unknown fields and bad modes", async () => {
    const r1 = await call(`/v1/sessions/${sessionId}`, { method: "PATCH", body: JSON.stringify({ bogus: "hax" }) });
    expect(r1.status).toBe(400);
    const r2 = await call(`/v1/sessions/${sessionId}`, { method: "PATCH", body: JSON.stringify({ permission_mode: "yolo" }) });
    expect(r2.status).toBe(400);
    const r3 = await call(`/v1/sessions/${sessionId}`, { method: "PATCH", body: JSON.stringify({ status: "" }) });
    expect(r3.status).toBe(400);
  });

  test("PATCH status flips the row's status", async () => {
    const r = await call(`/v1/sessions/${sessionId}`, { method: "PATCH", body: JSON.stringify({ status: "running" }) });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).status).toBe("running");
    expect((await Sessions.findById(sessionId))!.status).toBe("running");
    await call(`/v1/sessions/${sessionId}`, { method: "PATCH", body: JSON.stringify({ status: "idle" }) });
  });

  test("session id must match the JWT claim (403), unknown id under own claim (404)", async () => {
    const other = await Sessions.createForThread({
      thread: { team_id: "T1", channel_id: "C0TEAM", thread_ts: "200.0" },
      model: "m",
      working_dir: "/tmp/wd",
    });
    const r = await call(`/v1/sessions/${other.id}`); // token scoped to sessionId
    expect(r.status).toBe(403);
    const r2 = await call(`/v1/sessions/00000000-0000-0000-0000-000000000000`, {}, { job: jobToken("00000000-0000-0000-0000-000000000000") });
    expect(r2.status).toBe(404);
  });
});

describe("/v1/tenants/:id/runtime", () => {
  test("requires a job token (decrypted creds are not bearer-only)", async () => {
    const r = await call(`/v1/tenants/default/runtime`, {}, { job: null });
    expect(r.status).toBe(401);
  });

  test("job token scoped to another tenant → 403", async () => {
    const foreign = mintJobToken({ ...claimsFor(sessionId), tenant: "other-tenant" });
    const r = await call(`/v1/tenants/default/runtime`, {}, { job: foreign });
    expect(r.status).toBe(403);
  });

  test("a planted ${SLAUDE_MASTER_KEY} in the shared .mcp.json never reaches the bundle", async () => {
    const file = `${paths.home}/.mcp.json`;
    const prev = process.env.SLAUDE_MASTER_KEY;
    process.env.SLAUDE_MASTER_KEY = "planted-master-key-value";
    await Bun.write(file, JSON.stringify({ mcpServers: { x: { type: "http", url: "https://x.test/mcp", headers: { a: "${SLAUDE_MASTER_KEY}" } } } }));
    try {
      const r = await call(`/v1/tenants/default/runtime`);
      const text = await r.text();
      expect(JSON.parse(text).mcpJson).toBeNull();
      expect(text).not.toContain("planted-master-key-value");
    } finally {
      rmSync(file, { force: true });
      if (prev === undefined) delete process.env.SLAUDE_MASTER_KEY;
      else process.env.SLAUDE_MASTER_KEY = prev;
    }
  });

  test("returns the default-tenant bundle with an ETag; If-None-Match → 304", async () => {
    const r = await call(`/v1/tenants/default/runtime`);
    expect(r.status).toBe(200);
    const etag = r.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const bundle = (await r.json()) as any;
    expect(bundle.tenantId).toBe("default");
    expect(bundle.personaId).toBe("default");
    expect(bundle.soulMd).toContain("# SOUL"); // fixture file on disk
    expect(Array.isArray(bundle.skillsPaths)).toBe(true);
    expect(bundle.skillsPaths[0]).toBe(paths.skills);
    // Nodes never read mcpJson; the shared, node-writable .mcp.json expanded
    // against the gateway's env must never ride in the bundle.
    expect(bundle.mcpJson).toBeNull();
    expect(typeof bundle.providerCreds).toBe("object");

    const r304 = await call(`/v1/tenants/default/runtime`, { headers: { "if-none-match": etag } });
    expect(r304.status).toBe(304);
    expect(r304.headers.get("etag")).toBe(etag);

    // RFC 7232: If-None-Match: * matches any current representation.
    const rStar = await call(`/v1/tenants/default/runtime`, { headers: { "if-none-match": "*" } });
    expect(rStar.status).toBe(304);
  });

  test("unknown tenant (token scoped to it) → 404", async () => {
    const foreign = mintJobToken({ ...claimsFor(sessionId), tenant: "nope" });
    const r = await call(`/v1/tenants/nope/runtime`, {}, { job: foreign });
    expect(r.status).toBe(404);
  });
});

describe("/v1/pending/:id", () => {
  test("unknown id → 404", async () => {
    const r = await call(`/v1/pending/does-not-exist`, {}, { job: null });
    expect(r.status).toBe(404);
  });

  test("long-poll resolves when the gate settles on another 'replica'", async () => {
    const source = handle.__pendingSource();
    const row = await source.create("approval", sessionId, { summary: "do the thing" }, Date.now() + 60_000);
    const poll = call(`/v1/pending/${row.id}`, {}, { job: null });
    setTimeout(() => void source.resolve(row.id, "approved", WORLD.manager), 120);
    const r = await poll;
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      status: "approved",
      payload: { summary: "do the thing" },
      resolvedBy: WORLD.manager,
    });
  });

  test("already-expired gate reports expired immediately", async () => {
    const source = handle.__pendingSource();
    const row = await source.create("perm", sessionId, { tool: "Bash" }, Date.now() - 1);
    const r = await call(`/v1/pending/${row.id}`, {}, { job: null });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).status).toBe("expired");
  });
});

describe("/v1/jobs/:id", () => {
  test("ack and fail are accepted", async () => {
    const r1 = await call(`/v1/jobs/j1/ack`, { method: "POST", body: JSON.stringify({ ms: 12 }) }, { job: null });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ ok: true });
    const r2 = await call(`/v1/jobs/j1/fail`, { method: "POST", body: JSON.stringify({ error: "boom" }) }, { job: null });
    expect(r2.status).toBe(200);
  });
});

describe("/v1/tools — REST tool plane", () => {
  test("surface/reply posts to the claims' conversation and returns the MCP-shaped result", async () => {
    const before = posts.length;
    const r = await call(`/v1/tools/surface/reply`, { method: "POST", body: JSON.stringify({ text: "hello from REST" }) });
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body).toEqual({ content: [{ type: "text", text: "posted ref=1.1" }] });
    const post = posts[posts.length - 1];
    expect(posts.length).toBe(before + 1);
    expect(post.channel).toBe("C0TEAM");
    expect(post.thread_ts).toBe("100.0");
    expect(post.text).toContain("hello from REST");
  });

  test("slack/reply (deprecated alias) matches the direct handler result", async () => {
    // direct MCP-handler result against an identical context:
    const direct = await slackHandlers.reply(
      {
        client: { chat: { postMessage: async () => ({ ts: "1.1" }) } } as any,
        channel: "C0TEAM",
        threadTs: "100.0",
        inboundTs: "100.0",
        userId: WORLD.manager,
      },
      { text: "hi" },
    );
    const r = await call(`/v1/tools/slack/reply`, { method: "POST", body: JSON.stringify({ text: "hi" }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(direct as any);
  });

  test("runtime/list_cron_jobs matches the direct MCP handler result", async () => {
    await db.run("DELETE FROM cron_jobs");
    await CronJobs.create({
      slackTeamId: "T1",
      slackChannelId: "C0TEAM",
      slackThreadTs: "100.0",
      channelId: "C0TEAM",
      threadTs: "100.0",
      createdBy: WORLD.manager,
      cronExpr: "0 9 * * *",
      prompt: "daily summary",
      nextRunAt: Date.now() + 3600_000,
    });
    const direct = await adminHandlers.listCronJobs({
      client: {} as any,
      channel: "C0TEAM",
      threadTs: "100.0",
      inboundTs: "100.0",
      userId: WORLD.manager,
    });
    const r = await call(`/v1/tools/runtime/list_cron_jobs`, { method: "POST", body: "{}" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(direct as any);
    const text = (direct as any).content[0].text;
    expect(text).toContain("daily summary");
  });

  test("runtime/list_cron_jobs is refused for a non-manager initiator", async () => {
    const outsider = mintJobToken({ ...claimsFor(sessionId), initiator: "U0RANDO" });
    const r = await call(`/v1/tools/runtime/list_cron_jobs`, { method: "POST", body: "{}" }, { job: outsider });
    expect(r.status).toBe(200); // MCP-shaped error result, not an HTTP error
    const body = (await r.json()) as any;
    expect(body.isError).toBe(true);
    expect(body.content[0].text).toContain("Only manager or approver");
  });

  test("runtime/proactive_rule takes its teacher from the signed initiator, on the job's own sender only", async () => {
    // The job's recorded senders (the queue's turn-senders record, by token job id).
    const sendersByJob: Record<string, Array<{ userId: string; teamId: string | null; origin: string | null }>> = {
      "J-own": [{ userId: "U0RELAY", teamId: "T1", origin: "slack" }],
      "J-merged": [{ userId: "U0RELAY", teamId: "T1", origin: "slack" }, { userId: "U0OTHER", teamId: "T1", origin: "slack" }],
    };
    const qd = {
      dispatch: async () => {},
      abort: async () => {},
      pubsub: { close: async () => {} },
      turns: { close: async () => {}, turnSenders: async (job: string) => sendersByJob[job] ?? null },
      registry: { close: async () => {}, liveLabels: async () => [] },
      close: async () => {},
    } as any;
    const gw = createGateway(new AgentManager(), capturingTransport().t, { queueDispatch: qd });
    const brain = fakeBrain();
    __setRuleBrainCall(brain.call);
    try {
      const source = agentSourceId(await backgroundAgentId("default"));
      const slug = "rules/proactive/build-failures-c0team";
      const post = async (body: unknown, claims: Partial<JobClaims>) => {
        const token = mintJobToken({ ...claimsFor(sessionId), initiator: "U0RELAY", origin: "slack", ...claims });
        const res = (await gw.fetchV1(new Request("http://gw/v1/tools/runtime/proactive_rule", {
          method: "POST",
          headers: { authorization: `Bearer ${NODE_TOKEN}`, [JOB_HEADER]: token, "content-type": "application/json" },
          body: JSON.stringify(body),
        })))!;
        return { status: res.status, json: res.status === 200 ? ((await res.json()) as any) : null };
      };
      const body = { kind: "build failures", scope: "here", level: "ignore", quote: "stop telling me" };
      // A teacher named in the body is not an argument: the strict parse refuses it.
      expect((await post({ ...body, taughtBy: "U0EVIL" }, { job: "J-own" })).status).toBe(400);
      // A merged job, an unrecorded one, and a cron-origin token are not one person's own turn.
      for (const claims of [{ job: "J-merged" }, { job: "J-unrecorded" }, { job: "J-own", origin: "cron" as const }]) {
        const r = await post(body, claims);
        expect(r.status).toBe(200);
        expect(r.json.isError).toBe(true);
      }
      expect(brain.contentOf(source, slug)).toBeUndefined();
      const r = await post(body, { job: "J-own" });
      expect(r.json.isError).toBeUndefined();
      const page = readPageRecord({ content: brain.contentOf(source, slug) })!;
      expect(page.meta.taught_by).toBe("U0RELAY");
      expect(page.meta.thread).toBe("C0TEAM/100.0");
    } finally {
      __setRuleBrainCall(null);
      await gw.stop();
    }
  });

  test("skills/list_skills matches the direct MCP handler result", async () => {
    if (existsSync(paths.skills)) rmSync(paths.skills, { recursive: true, force: true });
    mkdirSync(paths.skills, { recursive: true });
    skillOps.write("rest-check", "REST Check", "verify the tool plane", "Say hi.\n");
    const direct = await skillHandlers.list_skills();
    const r = await call(`/v1/tools/skills/list_skills`, { method: "POST", body: "{}" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(direct as any);
    expect((direct as any).content[0].text).toContain("rest-check");
  });

  test("skills/write_skill and delete_skill refuse a built-in name over REST", async () => {
    for (const tool of ["write_skill", "delete_skill"]) {
      const body = tool === "write_skill"
        ? { slug: "skill-authoring", name: "x", description: "y", body: "z" }
        : { slug: "skill-authoring" };
      const r = await call(`/v1/tools/skills/${tool}`, { method: "POST", body: JSON.stringify(body) });
      expect(r.status).toBe(200);
      const j = (await r.json()) as any;
      expect(j.isError).toBe(true);
      expect(j.content[0].text).toBe("`skill-authoring` is a built-in skill and cannot be changed at runtime");
    }
  });

  test("kb/search_kbs matches the direct MCP handler result", async () => {
    const direct = await kbHandlers.search_kbs({ query: "anything at all" });
    const r = await call(`/v1/tools/kb/search_kbs`, { method: "POST", body: JSON.stringify({ query: "anything at all" }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(direct as any);
  });

  test("invalid body → 400 with zod detail; unknown server/tool → 404", async () => {
    const r1 = await call(`/v1/tools/surface/reply`, { method: "POST", body: JSON.stringify({ nope: 1 }) });
    expect(r1.status).toBe(400);
    expect(((await r1.json()) as any).error).toContain("text");
    const r2 = await call(`/v1/tools/surface/reply`, { method: "POST", body: "{not json" });
    expect(r2.status).toBe(400);
    const r3 = await call(`/v1/tools/nope/reply`, { method: "POST", body: "{}" });
    expect(r3.status).toBe(404);
    const r4 = await call(`/v1/tools/surface/nope`, { method: "POST", body: "{}" });
    expect(r4.status).toBe(404);
  });
});
