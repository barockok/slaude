/**
 * U2 follow-up F2: the route context carries the event app's bot token on
 * both inbound paths — when a session's route is first seeded, and when a
 * later message re-points the existing route. read_canvas downloads with it;
 * HTTP mode has no environment token to fall back on.
 *
 * Also F1's cron and /v1 paths: with no inbound event, the context resolves
 * the token from the session's app through the transport's registry.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { createGateway, type GatewayHandle } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { AppRef, Transport } from "../../../src/gateway/core/transport";
import { db } from "../../../src/db/schema";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import * as CronJobs from "../../../src/db/cron-jobs";

function setup(opts: { botTokenFor?: (app: AppRef) => string | undefined } = {}) {
  const handlers = new Map<string, (args: any) => Promise<void>>();
  const client: any = {
    auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
    chat: { postMessage: async () => ({ ok: true, ts: "1.1" }), update: async () => ({ ok: true }) },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    conversations: {
      info: async () => ({ channel: { properties: { canvas: { file_id: "F_CANVAS" } } } }),
      members: async () => ({}),
      replies: async () => ({}),
    },
    files: { info: async () => ({ file: { url_private_download: "https://files.example.com/canvas" } }) },
    users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
    search: { messages: async () => ({}) },
  };
  const t: Transport = {
    client,
    ...(opts.botTokenFor ? { botTokenFor: opts.botTokenFor } : {}),
    action: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
    event: (name: string, fn: any) => void handlers.set(name, fn),
  };
  const agent = new AgentManager();
  const sessions: string[] = [];
  agent.sendMessage = async (id: string) => void sessions.push(id);
  const handle: GatewayHandle = createGateway(agent, t);
  const dm = (ts: string, threadTs: string | undefined, context: any) =>
    handlers.get("message")!({
      event: { type: "message", channel: "D_MGR", channel_type: "im", user: WORLD.manager, team: "T", ts, text: "hello", ...(threadTs ? { thread_ts: threadTs } : {}) },
      client,
      context,
    });
  const slackCtx = async (sessionId: string) => {
    await handle.__resolveMcp(sessionId);
    return handle.__sessionCtx(sessionId)!.slack;
  };
  return { dm, sessions, slackCtx, handle };
}

describe("route context bot token", () => {
  beforeEach(async () => {
    await db.run("DELETE FROM sessions");
    await db.run("DELETE FROM seen_events");
    await db.run("DELETE FROM cron_jobs");
    writeSoulFixture(WORLD);
  });

  it("a new route takes the event's token, and a later message on the same route replaces it", async () => {
    const g = setup();
    await g.dm("910.1", undefined, { teamId: "T", apiAppId: "A0ONE", botToken: "event-token-1" });
    const sid = g.sessions[0]!;
    expect((await g.slackCtx(sid)).botToken).toBe("event-token-1");
    expect((await g.slackCtx(sid)).apiAppId).toBe("A0ONE");

    await g.dm("910.2", "910.1", { teamId: "T", apiAppId: "A0ONE", botToken: "event-token-2" });
    expect(g.sessions[1]).toBe(sid);
    expect((await g.slackCtx(sid)).botToken).toBe("event-token-2");
  });

  it("a cron run's context resolves the token from the job's app", async () => {
    const asked: AppRef[] = [];
    await CronJobs.create({
      slackTeamId: "T",
      slackAppId: "A0TWO",
      slackChannelId: "C_CRON",
      channelId: "C_CRON",
      createdBy: WORLD.manager,
      cronExpr: "* * * * *",
      prompt: "work",
      nextRunAt: Date.now() - 1000,
      target: "channel",
    });
    // The scheduler ticks once at construction (mono); wait for it to dispatch.
    const g = setup({ botTokenFor: (app) => (asked.push(app), app.apiAppId === "A0TWO" ? "registry-token-b" : undefined) });
    const deadline = Date.now() + 3000;
    while (!g.sessions.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    const ctx = await g.slackCtx(g.sessions[0]!);
    expect(ctx.botToken).toBeUndefined();
    expect(ctx.resolveBotToken?.()).toBe("registry-token-b");
    expect(asked.at(-1)).toEqual({ apiAppId: "A0TWO", teamId: "T" });
    await g.handle.stop();
  });

  it("read_canvas over /v1 downloads with the token of the app signed into the job token", async () => {
    const saved = { node: process.env.SLAUDE_NODE_TOKEN, job: process.env.SLAUDE_JOB_SECRET, fetch: globalThis.fetch };
    process.env.SLAUDE_NODE_TOKEN = "route-test-node-token";
    process.env.SLAUDE_JOB_SECRET = "route-test-job-secret";
    const auths: string[] = [];
    globalThis.fetch = (async (_u: any, init: any) => (auths.push(String(init?.headers?.Authorization)), new Response("canvas body"))) as any;
    try {
      const g = setup({ botTokenFor: (app) => (app.apiAppId === "A0TWO" && app.teamId === "T" ? "registry-token-b" : undefined) });
      const { mintJobToken, JOB_HEADER } = await import("../../../src/gateway/api/auth");
      const call = async (app?: string) => {
        const token = mintJobToken({
          tenant: "default", persona: "default", session: "S-v1-canvas", team: "T", channel: "C_V1", thread: "1.0",
          initiator: WORLD.manager, scope: "turn", ...(app ? { app } : {}),
        });
        const res = await g.handle.fetchV1(
          new Request("http://gw/v1/tools/slack/read_canvas", {
            method: "POST",
            headers: { authorization: "Bearer route-test-node-token", [JOB_HEADER]: token },
            body: "{}",
          }),
        );
        return (await res!.json()) as any;
      };
      const ok = await call("A0TWO");
      expect(ok.isError).toBeFalsy();
      expect(ok.content[0].text).toBe("canvas body");
      expect(auths).toEqual(["Bearer registry-token-b"]);
      // A token naming no app resolves nothing here (the stub knows only A0TWO).
      const none = await call();
      expect(none.isError).toBe(true);
      expect(auths).toHaveLength(1);
      await g.handle.stop();
    } finally {
      globalThis.fetch = saved.fetch;
      for (const [k, v] of [["SLAUDE_NODE_TOKEN", saved.node], ["SLAUDE_JOB_SECRET", saved.job]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
