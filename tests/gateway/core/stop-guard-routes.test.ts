/**
 * Mono's must-reply Stop guard on a reused route: a person's message after a
 * cron run (a silent route) is guarded again, and a console (panel) turn
 * starts the guard over, as a node does for a Slack or panel job
 * (src/node/stop-guard.ts).
 */
import { afterAll, describe, expect, it } from "bun:test";
import { createGateway, type GatewayHandle } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import { db } from "../../../src/db/schema";
import * as CronJobs from "../../../src/db/cron-jobs";
import { MUST_REPLY_INSTRUCTION } from "../../../src/agent/must-reply";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";

function transport() {
  const handlers = new Map<string, (args: any) => Promise<void>>();
  const client = {
    auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
    chat: { postMessage: async () => ({ ok: true, ts: `${Date.now()}.1` }), update: async () => ({ ok: true }) },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
    users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
    search: { messages: async () => ({}) },
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
  } as any;
  const t: Transport = { client, action: () => {}, event: (n: string, fn: any) => handlers.set(n, fn), use: () => {}, start: async () => {}, stop: async () => {} };
  return { t, client, emit: async (n: string, a: any) => { await handlers.get(n)?.(a); } };
}

const THREAD = "7100.1";
let h: GatewayHandle | undefined;
afterAll(async () => {
  h?.stop();
  await db.run("DELETE FROM cron_jobs");
});

describe("mono Stop guard on a reused route", () => {
  it("a person's message after a cron run is guarded; a panel turn starts the guard over", async () => {
    writeSoulFixture(WORLD);
    await db.run("DELETE FROM cron_jobs");
    // A due thread cron job runs at boot and binds the thread's route as silent.
    await CronJobs.create({
      slackTeamId: "T", slackChannelId: "D_MGR", slackThreadTs: THREAD, channelId: "D_MGR",
      createdBy: WORLD.manager, cronExpr: "0 0 1 1 *", prompt: "tick", nextRunAt: Date.now() - 1000, target: "thread",
    });
    const cap = transport();
    const agent = new AgentManager();
    let guard!: (id: string) => string | null;
    const orig = agent.setStopGuard.bind(agent);
    agent.setStopGuard = ((fn: any) => { guard = fn; orig(fn); }) as any;
    const sent: Array<[string, string]> = [];
    agent.sendMessage = async (id: string, text: string) => { sent.push([id, text]); };
    h = createGateway(agent, cap.t);
    const session = await agent.ensureSession({ team_id: "T", channel_id: "D_MGR", thread_ts: THREAD });
    const { until } = await import("../../queue/real");
    await until(() => sent.some(([id, text]) => id === session.id && text.startsWith("[scheduled]")), 2_000);
    // The cron run's route is silent: never forced.
    expect(guard(session.id)).toBeNull();

    // A person replies in the thread: the reused route is no longer silent.
    await cap.emit("message", {
      event: { type: "message", channel: "D_MGR", channel_type: "im", user: WORLD.manager, team: "T", ts: "7100.2", thread_ts: THREAD, text: "are you there?" },
      client: cap.client,
      context: { teamId: "T" },
    });
    expect(guard(session.id)).toBe(MUST_REPLY_INSTRUCTION);

    // The agent answers; then an operator sends a console message: a new turn,
    // so the earlier reply no longer satisfies the guard.
    agent.emit("event", { type: "toolCall", sessionId: session.id, tool: "mcp__slaude_surface__reply", input: {} } as any);
    await new Promise((r) => setTimeout(r, 10));
    expect(guard(session.id)).toBeNull();
    const row = (await (await import("../../../src/db/sessions")).findById(session.id))!;
    await h.__panelChat!(row, "status?", "U0OPER");
    expect(guard(session.id)).toBe(MUST_REPLY_INSTRUCTION);

    // A pass in the panel turn satisfies it; the next panel turn starts over again.
    agent.emit("event", { type: "toolCall", sessionId: session.id, tool: "mcp__slaude_surface__pass", input: {} } as any);
    await new Promise((r) => setTimeout(r, 10));
    expect(guard(session.id)).toBeNull();
    await h.__panelChat!(row, "and now?", "U0OPER");
    expect(guard(session.id)).toBe(MUST_REPLY_INSTRUCTION);
  });
});
