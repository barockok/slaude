// R40-I4: a retired (tombstoned) persona's Slack identity stops routing. An event
// addressed to it is dropped with a log naming only the persona; it is never
// handled as the default persona, and never mistaken for a colleague mention.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createGateway } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { __resetSoulDataMemo } from "../../../src/soul/extract";
import { paths } from "../../../src/config/home";
import * as Sessions from "../../../src/db/sessions";
import { __resetPersonaRegistry, setPersonaRegistry, type PersonaRegistry } from "../../../src/persona/registry";

const TEAM = "T";
const CH = "C0PUB";
const RETIRED = "UTESTANA1";

function capturingTransport() {
  const handlers = new Map<string, (args: any) => Promise<void>>();
  const t: Transport = {
    client: {
      auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
      chat: { postMessage: async () => ({ ok: true, ts: "1.1" }), update: async () => ({ ok: true }) },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
      users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
      search: { messages: async () => ({}) },
    } as any,
    action: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
    event: (name: string, fn: any) => { handlers.set(name, fn); },
  };
  const emit = async (name: string, args: any) => { await handlers.get(name)?.(args); };
  return { t, emit };
}

/** A managed registry with no live named persona and one retired identity. */
const managedRegistry = (): PersonaRegistry => ({
  lookupByUserId: () => null,
  lookupByName: () => null,
  list: () => [],
  isMultiPersonaMode: () => false,
  isManaged: () => true,
  tombstonedPersonaFor: (id) => (id === RETIRED ? "ana" : null),
});

const channelMsg = (ts: string, text: string, threadTs: string, client: any) => ({
  event: { type: "message", channel: CH, channel_type: "channel", user: WORLD.manager, team: TEAM, ts, thread_ts: threadTs, text },
  client,
  context: { teamId: TEAM },
});

const CACHE_DIR = join(paths.home, "cache");
beforeEach(() => {
  if (existsSync(CACHE_DIR)) rmSync(CACHE_DIR, { recursive: true, force: true });
  __resetSoulDataMemo();
  writeSoulFixture(WORLD);
  setPersonaRegistry(managedRegistry());
});
afterEach(() => {
  __resetPersonaRegistry();
  __resetSoulDataMemo();
  try { rmSync(paths.soul, { force: true }); } catch {}
});

describe("a tombstoned persona's identity", () => {
  it("a mention of it is dropped and logged by persona name; the thread's engagement is untouched", async () => {
    const { t, emit } = capturingTransport();
    const agent = new AgentManager();
    const send = mock(async () => {});
    agent.sendMessage = send as any;
    createGateway(agent, t, {});
    const thread = `${Date.now()}.100`;
    const row = await agent.ensureSession({ team_id: TEAM, channel_id: CH, thread_ts: thread, persona_id: "default" });
    await Sessions.setEngaged(row.id, true);
    const log = spyOn(console, "log");
    try {
      await emit("message", channelMsg(`${Date.now()}.101`, `<@${RETIRED}> are you there?`, thread, t.client));
      const lines = log.mock.calls.map((c) => c.map(String).join(" "));
      expect(lines.some((l) => l.includes("drop") && l.includes("persona=ana"))).toBe(true);
    } finally {
      log.mockRestore();
    }
    expect(send).toHaveBeenCalledTimes(0);
    expect((await Sessions.findByThread({ team_id: TEAM, channel_id: CH, thread_ts: thread, persona_id: "default" }))!.engaged).toBeTruthy();
  });

  it("a plain reply in a thread engaged with a persona no longer live is dropped, not run as default", async () => {
    const { t, emit } = capturingTransport();
    const agent = new AgentManager();
    const send = mock(async () => {});
    agent.sendMessage = send as any;
    createGateway(agent, t, {});
    const thread = `${Date.now()}.200`;
    const row = await agent.ensureSession({ team_id: TEAM, channel_id: CH, thread_ts: thread, persona_id: "ana" });
    await Sessions.setEngaged(row.id, true);
    const log = spyOn(console, "log");
    try {
      await emit("message", channelMsg(`${Date.now()}.201`, "and another thing", thread, t.client));
      const lines = log.mock.calls.map((c) => c.map(String).join(" "));
      expect(lines.some((l) => l.includes("drop") && l.includes("persona=ana"))).toBe(true);
    } finally {
      log.mockRestore();
    }
    expect(send).toHaveBeenCalledTimes(0);
  });
});
