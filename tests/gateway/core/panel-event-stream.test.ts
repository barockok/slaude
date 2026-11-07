/**
 * Mono with the console on: the agent's events and each delivered Slack
 * message reach the session's event stream (events:<id>), which the console's
 * live tail reads. On nodes the worker appends agent events; in mono nothing
 * did. The Slack message is display only: it never reaches the agent as an
 * event. The agent's sendMessage is stubbed; the panel infra is a fake.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createGateway, type GatewayHandle, type PanelInfra } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import * as OneOnOne from "../../../src/db/one-on-one";
import * as Sessions from "../../../src/db/sessions";
import { voiceTurns } from "../../../src/voice/turn-flags";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";

function transport() {
  const handlers = new Map<string, (args: any) => Promise<void>>();
  const client: any = {
    auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
    chat: { postMessage: async () => ({ ok: true, ts: "1.1" }), update: async () => ({ ok: true }) },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    conversations: { info: async () => ({}), members: async () => ({ members: [] }), replies: async () => ({ messages: [] }) },
    users: { info: async () => ({ user: { real_name: "Alice Example" } }), profile: { set: async () => ({}) } },
    search: { messages: async () => ({}) },
  };
  const t: any = {
    client,
    action: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
    event: (name: string, fn: any) => void handlers.set(name, fn),
  };
  const mention = async (user: string, thread: string, ts: string, text: string) => {
    const event = { type: "message", channel: "C0TEAM", channel_type: "channel", user, team: "T", ts, thread_ts: thread, text: `<@U_SLAUDE> ${text}` };
    const args = { event, client, context: { teamId: "T" } };
    await handlers.get("app_mention")?.({ ...args, event: { ...event, type: "app_mention" } });
    await handlers.get("message")!(args);
  };
  /** A plain (no mention) reply in the thread. */
  const reply = async (user: string, thread: string, ts: string, text: string) => {
    const event = { type: "message", channel: "C0TEAM", channel_type: "channel", user, team: "T", ts, thread_ts: thread, text };
    await handlers.get("message")!({ event, client, context: { teamId: "T" } });
  };
  return { t, mention, reply };
}

let appended: Array<{ sessionId: string; event: any }>;
const infra = (): PanelInfra =>
  ({
    registry: { lookup: async () => null, countWarm: async () => 0 },
    pubsub: {
      appendEvent: async (sessionId: string, event: unknown) => {
        appended.push({ sessionId, event });
        return `${appended.length}-0`;
      },
      onPanelResume: async () => async () => {},
      onPanelHold: async () => async () => {},
      publishPanelResume: async () => 0,
      publishPanelHold: async () => 0,
    },
    panelLock: { owner: async () => null, noticeOnce: async () => false, clearNotice: async () => {} },
  }) as unknown as PanelInfra;

let h: GatewayHandle | null = null;
let agent: AgentManager;
let sent: Array<{ id: string; text: string }>;
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(10);
  expect(cond()).toBe(true);
};

beforeEach(async () => {
  appended = [];
  sent = [];
  writeSoulFixture(WORLD);
  await OneOnOne._wipeForTests();
  agent = new AgentManager();
  agent.sendMessage = async (id: string, text: string) => {
    sent.push({ id, text });
  };
});
afterEach(async () => {
  await h?.stop();
  h = null;
});

describe("mono: the console's event stream", () => {
  test("a delivered Slack message is appended as userMessage (redacted), and agent events follow it", async () => {
    const agentEvents: any[] = [];
    agent.on("event", (e) => agentEvents.push(e));
    const { t, mention } = transport();
    h = createGateway(agent, t, { panel: infra() });
    await mention("U0ALICE", "800.0", "800.1", "deploy with password=hunter2secret please");
    await until(() => sent.length === 1);
    const sid = sent[0]!.id;

    const shown = appended.filter((a) => a.event.type === "userMessage");
    expect(shown).toHaveLength(1);
    expect(shown[0]!.sessionId).toBe(sid);
    expect(shown[0]!.event.userId).toBe("U0ALICE");
    expect(shown[0]!.event.text).toContain("deploy with");
    expect(shown[0]!.event.text).not.toContain("hunter2secret");
    expect(shown[0]!.event.text).not.toContain("<@U_SLAUDE>");
    // Display only: never an agent event, and not part of the turn's input
    // beyond the message the turn already carries.
    expect(agentEvents.some((e) => e.type === "userMessage")).toBe(false);

    agent.emit("event", { type: "toolCall", sessionId: sid, tool: "Bash", input: {}, toolUseId: "tu_1" });
    const last = appended.at(-1)!;
    expect(last.sessionId).toBe(sid);
    expect(last.event).toEqual({ type: "toolCall", sessionId: sid, tool: "Bash", input: {}, toolUseId: "tu_1" });
  });

  test("a voice turn is kept off: no userMessage, and the agent's events are not appended", async () => {
    const { t, mention } = transport();
    h = createGateway(agent, t, { panel: infra() });
    await mention("U0ALICE", "820.0", "820.1", "first");
    await until(() => sent.length === 1);
    const sid = sent[0]!.id;
    appended = [];
    voiceTurns.enter(sid);
    try {
      await mention("U0ALICE", "820.0", "820.2", "during the call");
      await until(() => sent.length === 2);
      agent.emit("event", { type: "assistantText", sessionId: sid, text: "voice answer" });
      expect(appended).toEqual([]);
    } finally {
      voiceTurns.exit(sid);
    }
    agent.emit("event", { type: "assistantText", sessionId: sid, text: "after the call" });
    expect(appended.map((a) => a.event.text)).toEqual(["after the call"]);
  });

  test("a suppressed message (disengaged thread) is recorded but not shown", async () => {
    const { t, mention, reply } = transport();
    h = createGateway(agent, t, { panel: infra() });
    await mention("U0ALICE", "830.0", "830.1", "start");
    await until(() => sent.length === 1);
    await Sessions.setEngaged(sent[0]!.id, false);
    appended = [];
    await reply("U0BOB", "830.0", "830.2", "just chatting among ourselves");
    await until(() => sent.length === 2); // recorded into the transcript, suppressed
    expect(appended.filter((a) => a.event.type === "userMessage")).toEqual([]);
  });

  test("without the console nothing is appended", async () => {
    const { t, mention } = transport();
    h = createGateway(agent, t, { panel: null });
    await mention("U0ALICE", "810.0", "810.1", "hello");
    await until(() => sent.length === 1);
    expect(appended).toEqual([]);
  });
});
