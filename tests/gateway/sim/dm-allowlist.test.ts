import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createGateway } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { __resetSoulDataMemo } from "../../../src/soul/extract";
import { paths } from "../../../src/config/home";
import * as OneOnOne from "../../../src/db/one-on-one";

/** Records posts + captures the registered message handler so a test can drive an
 *  inbound DM through the gateway. */
function capturingTransport() {
  const posts: any[] = [];
  const handlers = new Map<string, (args: any) => Promise<void>>();
  const t: Transport = {
    client: {
      auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
      chat: { postMessage: async (a: any) => { posts.push(a); return { ok: true, ts: "1.1" }; }, update: async () => ({ ok: true }) },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
      users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
      search: { messages: async () => ({}) },
    } as any,
    action: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
    event: (name: string, fn: any) => { handlers.set(name, fn); },
  };
  const emit = async (name: string, args: any) => { await handlers.get(name)?.(args); };
  return { t, posts, emit };
}

const TEAM = "T";
const DM_CHANNEL = "D0DM";
const DM_USER = "U0DMUSER01";

function dmInbound(user: string, ts: string, client: any) {
  return {
    event: { type: "message", channel: DM_CHANNEL, channel_type: "im", user, team: TEAM, ts, text: "hello" },
    client,
    context: { teamId: TEAM },
  };
}

const CACHE_DIR = join(paths.home, "cache");

beforeEach(() => {
  // An admitted DM forwards to the model, which downloads attachments — that reads
  // SLACK_BOT_TOKEN. Ensure it's set (another suite may have cleared it).
  process.env.SLACK_BOT_TOKEN ||= "xoxb-test";
  OneOnOne._wipeForTests();
  // Drop any soul cache a prior suite cached on the shared temp home, then seed our
  // fixture so soulData() returns the memo we set (not a foreign cache or fallback).
  if (existsSync(CACHE_DIR)) rmSync(CACHE_DIR, { recursive: true, force: true });
  __resetSoulDataMemo();
  writeSoulFixture({ ...WORLD, dmAllowed: [DM_USER] });
});

afterEach(() => {
  OneOnOne._wipeForTests();
  __resetSoulDataMemo();
  try { rmSync(paths.soul, { force: true }); } catch {}
});

describe("DM allowlist gate", () => {
  it("admits a whitelisted DM user (forwards to the model)", async () => {
    const { t, emit } = capturingTransport();
    const agent = new AgentManager();
    const sendMessage = mock(async () => {});
    agent.sendMessage = sendMessage as any;
    createGateway(agent, t, {});

    await emit("message", dmInbound(DM_USER, "100.1", t.client));

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("drops a non-whitelisted DM user (no forward)", async () => {
    const { t, emit } = capturingTransport();
    const agent = new AgentManager();
    const sendMessage = mock(async () => {});
    agent.sendMessage = sendMessage as any;
    createGateway(agent, t, {});

    await emit("message", dmInbound("U0RANDOM99", "100.2", t.client));

    expect(sendMessage).toHaveBeenCalledTimes(0);
  });

  it("still admits the manager in a DM", async () => {
    const { t, emit } = capturingTransport();
    const agent = new AgentManager();
    const sendMessage = mock(async () => {});
    agent.sendMessage = sendMessage as any;
    createGateway(agent, t, {});

    await emit("message", dmInbound(WORLD.manager, "100.3", t.client));

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
