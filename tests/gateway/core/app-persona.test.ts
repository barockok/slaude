/**
 * One Slack app per persona on one gateway. An app registered with
 * `slack-app add --persona <name>` runs what is addressed to its own bot (a DM,
 * an @mention of it, a reply in a thread it is engaged in) as that persona; the
 * reply goes out through that app's bot. An app registered for 'default', or for
 * a persona that is not live, behaves exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createGateway } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { AppRef, Transport } from "../../../src/gateway/core/transport";
import { db } from "../../../src/db/schema";
import * as Sessions from "../../../src/db/sessions";
import { __resetPersonaRegistry, setPersonaRegistry, type PersonaRegistry } from "../../../src/persona/registry";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";

const BOT = {
  A0MAIN: { user: "U0MAIN", bot: "B0MAIN", persona: "default" },
  A0ALPHA: { user: "U0ALPHA", bot: "B0ALPHA", persona: "alpha" },
  A0GHOST: { user: "U0GHOST", bot: "B0GHOST", persona: "ghost" },
} as const;
type AppId = keyof typeof BOT;

/** A registry that lists the persona `alpha` only: `ghost` is registered on an app but not live. */
const registry = (): PersonaRegistry => {
  const alpha = { name: "alpha", slackUserId: "U0ALPHAP", config: { slackUserId: "U0ALPHAP", name: "alpha" }, outClient: null } as any;
  return {
    lookupByUserId: (id) => (id === alpha.slackUserId ? alpha : null),
    lookupByName: (name) => (name === "alpha" ? alpha : null),
    list: () => [alpha],
    isMultiPersonaMode: () => true,
    isManaged: () => false,
    tombstonedPersonaFor: () => null,
  };
};

function setup() {
  const handlers = new Map<string, (args: any) => Promise<void>>();
  const calls: string[] = [];
  const clientOf = (app: AppId): any => ({
    auth: { test: async () => ({ user_id: BOT[app].user, bot_id: BOT[app].bot, team: "T", url: "x" }) },
    chat: { postMessage: async () => (calls.push(`post:${app}`), { ok: true, ts: "1.1" }), update: async () => ({ ok: true }) },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    conversations: { info: async () => ({}), members: async () => ({ ok: true, members: [WORLD.manager, ...Object.values(BOT).map((b) => b.user)] }), replies: async () => ({}) },
    users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
    search: { messages: async () => ({}) },
  });
  const clients = { A0MAIN: clientOf("A0MAIN"), A0ALPHA: clientOf("A0ALPHA"), A0GHOST: clientOf("A0GHOST") };
  const t: Transport = {
    client: clients.A0MAIN,
    clientFor: (app: AppRef) => clients[(app.apiAppId ?? "A0MAIN") as AppId],
    apps: async () => (Object.keys(BOT) as AppId[]).map((id) => ({ apiAppId: id, teamId: "T", botUserId: BOT[id].user, client: clients[id] })),
    action: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
    event: (name: string, fn: any) => void handlers.set(name, fn),
  };
  const agent = new AgentManager();
  const turns: string[] = [];
  agent.sendMessage = async (id: string) => void turns.push(id);
  createGateway(agent, t);
  // What the HTTP transport hands the handlers: the receiving app and the persona it is registered for.
  const context = (app: AppId) => ({ teamId: "T", apiAppId: app, botUserId: BOT[app].user, personaId: BOT[app].persona });
  const deliver = (app: AppId, event: Record<string, unknown>, name = "message", withPersona = true) =>
    handlers.get(name)!({
      event: { type: name, channel: "C0TEAM", channel_type: "channel", team: "T", ...event },
      client: clients[app],
      context: withPersona ? context(app) : { ...context(app), personaId: undefined },
    });
  return { deliver, turns, calls };
}

const persona = async (sessionId: string) => (await Sessions.findById(sessionId))!.persona_id;

describe("an app registered for a persona", () => {
  beforeEach(async () => {
    await db.run("DELETE FROM sessions");
    await db.run("DELETE FROM seen_events");
    writeSoulFixture(WORLD);
    setPersonaRegistry(registry());
  });
  afterEach(() => __resetPersonaRegistry());

  it("runs a DM to its bot as that persona, recorded under that app", async () => {
    const g = setup();
    await g.deliver("A0ALPHA", { user: WORLD.manager, channel: "D0DM1", channel_type: "im", ts: "100.1", text: "hello" });
    expect(g.turns).toHaveLength(1);
    const row = (await Sessions.findById(g.turns[0]!))!;
    expect(row.persona_id).toBe("alpha");
    expect(row.slack_app_id).toBe("A0ALPHA");
  });

  it("leaves a DM to an app registered for 'default' on the default persona", async () => {
    const g = setup();
    await g.deliver("A0MAIN", { user: WORLD.manager, channel: "D0DM2", channel_type: "im", ts: "101.1", text: "hello" });
    expect(g.turns).toHaveLength(1);
    expect(await persona(g.turns[0]!)).toBe("default");
  });

  it("runs an @mention of its bot in a channel as that persona", async () => {
    const g = setup();
    await g.deliver("A0ALPHA", { user: WORLD.manager, ts: "102.1", text: `<@${BOT.A0ALPHA.user}> status?` });
    expect(g.turns).toHaveLength(1);
    expect(await persona(g.turns[0]!)).toBe("alpha");
  });

  it("runs the app_mention delivery of the same mention as that persona, once", async () => {
    const g = setup();
    const mention = { user: WORLD.manager, ts: "103.1", text: `<@${BOT.A0ALPHA.user}> status?` };
    await g.deliver("A0ALPHA", mention, "app_mention");
    await g.deliver("A0ALPHA", mention); // the message event for the same ts is deduplicated
    expect(g.turns).toHaveLength(1);
    expect(await persona(g.turns[0]!)).toBe("alpha");
  });

  it("continues a plain reply in the thread it is engaged in as the same persona and session", async () => {
    const g = setup();
    await g.deliver("A0ALPHA", { user: WORLD.manager, ts: "104.1", text: `<@${BOT.A0ALPHA.user}> hi` });
    await g.deliver("A0ALPHA", { user: WORLD.manager, ts: "104.2", thread_ts: "104.1", text: "and another thing" });
    expect(g.turns).toHaveLength(2);
    expect(g.turns[1]).toBe(g.turns[0]!);
    expect(await persona(g.turns[1]!)).toBe("alpha");
  });

  it("keeps the default app's session in the same thread separate from the persona app's", async () => {
    const g = setup();
    await g.deliver("A0MAIN", { user: WORLD.manager, ts: "105.1", text: `<@${BOT.A0MAIN.user}> hi` });
    await g.deliver("A0ALPHA", { user: WORLD.manager, ts: "105.2", thread_ts: "105.1", text: `<@${BOT.A0ALPHA.user}> and you?` });
    const personas = await Promise.all(g.turns.map(persona));
    expect(personas.sort()).toEqual(["alpha", "default"]);
    expect(new Set(g.turns).size).toBe(2);
  });

  it("falls back to the default persona, with one warning, when its persona is not live", async () => {
    const g = setup();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await g.deliver("A0GHOST", { user: WORLD.manager, channel: "D0DM3", channel_type: "im", ts: "106.1", text: "one" });
      await g.deliver("A0GHOST", { user: WORLD.manager, channel: "D0DM3", channel_type: "im", ts: "106.2", text: "two" });
      const warnings = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("persona=ghost"));
      expect(warnings).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
    expect(g.turns).toHaveLength(2);
    expect(await persona(g.turns[0]!)).toBe("default");
  });

  it("is unchanged when the transport carries no per-app persona (Socket Mode, single app)", async () => {
    const g = setup();
    await g.deliver("A0ALPHA", { user: WORLD.manager, ts: "107.1", text: `<@${BOT.A0ALPHA.user}> hi` }, "message", false);
    expect(g.turns).toHaveLength(1);
    expect(await persona(g.turns[0]!)).toBe("default");
  });
});
