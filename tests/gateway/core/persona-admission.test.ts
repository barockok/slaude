/**
 * Admission and roles per persona at the gateway. A named persona on its own
 * Slack app is admitted by its own soul's channels and answers admin commands
 * from its own manager; stored grants widen (member) or narrow (deny) what
 * the soul admits.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createGateway } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { AppRef, Transport } from "../../../src/gateway/core/transport";
import { db } from "../../../src/db/schema";
import { __resetPersonaRegistry, setPersonaRegistry, type PersonaRegistry } from "../../../src/persona/registry";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { __setGrantsReader } from "../../../src/access/role";
import type { Grant } from "../../../src/access/grants";

const BOT = {
  A0MAIN: { user: "U0MAIN", bot: "B0MAIN", persona: "default" },
  A0ALPHA: { user: "U0ALPHA", bot: "B0ALPHA", persona: "alpha" },
} as const;
type AppId = keyof typeof BOT;

const ALPHA_MGR = "UALPHAMGR";
const ALPHA_CH = "C0ALPHA"; // alpha's own trusted channel; WORLD trusts C0TEAM

/** `alpha` carries a structured soul (managed persona): its own manager and channels. */
const registry = (soulJson: unknown): PersonaRegistry => {
  const alpha = { name: "alpha", slackUserId: "U0ALPHAP", config: { slackUserId: "U0ALPHAP", name: "alpha" }, outClient: null, soulJson } as any;
  return {
    lookupByUserId: (id) => (id === alpha.slackUserId ? alpha : null),
    lookupByName: (name) => (name === "alpha" ? alpha : null),
    list: () => [alpha],
    isMultiPersonaMode: () => true,
    isManaged: () => true,
    tombstonedPersonaFor: () => null,
  };
};

function setup() {
  const handlers = new Map<string, (args: any) => Promise<void>>();
  const posts: { app: AppId; text: string }[] = [];
  const clientOf = (app: AppId): any => ({
    auth: { test: async () => ({ user_id: BOT[app].user, bot_id: BOT[app].bot, team: "T", url: "x" }) },
    chat: { postMessage: async (a: any) => (posts.push({ app, text: String(a.text ?? "") }), { ok: true, ts: "1.1" }), update: async () => ({ ok: true }) },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    conversations: { info: async () => ({}), members: async () => ({ ok: true, members: [] }), replies: async () => ({}) },
    users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
    search: { messages: async () => ({}) },
  });
  const clients = { A0MAIN: clientOf("A0MAIN"), A0ALPHA: clientOf("A0ALPHA") };
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
  let seq = 500;
  const deliver = (app: AppId, user: string, channel: string, text: string) =>
    handlers.get("message")!({
      event: { type: "message", channel, channel_type: "channel", team: "T", user, ts: `${++seq}.1`, text: `<@${BOT[app].user}> ${text}` },
      client: clients[app],
      context: { teamId: "T", apiAppId: app, botUserId: BOT[app].user, personaId: BOT[app].persona },
    });
  return { deliver, turns, posts };
}

const stored = (g: Partial<Grant> & Pick<Grant, "subjectKind" | "subjectId">): Grant => ({
  role: "member", deny: false, dmOnly: false, source: "console", ...g,
});

beforeEach(async () => {
  await db.run("DELETE FROM sessions");
  await db.run("DELETE FROM seen_events");
  await db.run("DELETE FROM cron_jobs");
  writeSoulFixture(WORLD);
  __setGrantsReader(async () => []);
});
afterEach(() => {
  __resetPersonaRegistry();
  __setGrantsReader(null);
});

describe("a named persona on its own app", () => {
  beforeEach(() => {
    setPersonaRegistry(registry({ manager: { userId: ALPHA_MGR }, trustedChannels: [ALPHA_CH] }));
    writeSoulFixture(WORLD); // the registry reset drops the soul memo
  });

  it("admits anyone in its own trusted channel and drops them in a channel only the default trusts", async () => {
    const g = setup();
    await g.deliver("A0ALPHA", "U0BOB", ALPHA_CH, "hello");
    expect(g.turns).toHaveLength(1);
    await g.deliver("A0ALPHA", "U0BOB", "C0TEAM", "hello");
    expect(g.turns).toHaveLength(1);
    // The default persona keeps its own channels.
    await g.deliver("A0MAIN", "U0BOB", "C0TEAM", "hello");
    expect(g.turns).toHaveLength(2);
  });

  it("its own manager runs an admin command; the default's manager does not", async () => {
    const g = setup();
    await g.deliver("A0ALPHA", ALPHA_MGR, ALPHA_CH, "/cron-list");
    expect(g.posts.at(-1)?.text).toBe("No active cron jobs.");
    await g.deliver("A0ALPHA", WORLD.manager, ALPHA_CH, "/cron-list");
    expect(g.posts.at(-1)?.text).toContain("only manager or approver can list cron jobs");
    // On the default app the default's manager still may.
    await g.deliver("A0MAIN", WORLD.manager, "C0TEAM", "/cron-list");
    expect(g.posts.at(-1)?.text).toBe("No active cron jobs.");
  });

  it("its own manager is admitted in a channel no soul lists", async () => {
    const g = setup();
    await g.deliver("A0ALPHA", ALPHA_MGR, "CELSEWHERE", "hello");
    expect(g.turns).toHaveLength(1);
    await g.deliver("A0ALPHA", WORLD.manager, "CELSEWHERE", "hello");
    expect(g.turns).toHaveLength(1);
  });
});

describe("a named persona that names no access fields", () => {
  it("admits exactly what the default admits", async () => {
    setPersonaRegistry(registry({ identity: { name: "Alpha" }, mandate: "help" }));
    writeSoulFixture(WORLD);
    const g = setup();
    await g.deliver("A0ALPHA", "U0BOB", "C0TEAM", "hello");
    expect(g.turns).toHaveLength(1);
    await g.deliver("A0ALPHA", "U0BOB", "CELSEWHERE", "hello");
    expect(g.turns).toHaveLength(1);
    await g.deliver("A0ALPHA", WORLD.manager, "C0TEAM", "/cron-list");
    expect(g.posts.at(-1)?.text).toBe("No active cron jobs.");
  });
});

describe("stored grants", () => {
  it("a member grant lets a user chat in an unlisted channel", async () => {
    const g = setup();
    await g.deliver("A0MAIN", "U0BOB", "CELSEWHERE", "hello");
    expect(g.turns).toHaveLength(0);
    __setGrantsReader(async (p) => (p === "default" ? [stored({ subjectKind: "user", subjectId: "U0BOB" })] : []));
    await g.deliver("A0MAIN", "U0BOB", "CELSEWHERE", "hello");
    expect(g.turns).toHaveLength(1);
  });

  it("a deny drops a user in a trusted channel", async () => {
    const g = setup();
    await g.deliver("A0MAIN", "U0BOB", "C0TEAM", "hello");
    expect(g.turns).toHaveLength(1);
    __setGrantsReader(async (p) => (p === "default" ? [stored({ subjectKind: "user", subjectId: "U0BOB", deny: true })] : []));
    await g.deliver("A0MAIN", "U0BOB", "C0TEAM", "hello again");
    expect(g.turns).toHaveLength(1);
  });

  it("grants are per persona: a member grant on alpha does not admit on the default", async () => {
    setPersonaRegistry(registry({ manager: { userId: ALPHA_MGR }, trustedChannels: [ALPHA_CH] }));
    writeSoulFixture(WORLD);
    __setGrantsReader(async (p) => (p === "alpha" ? [stored({ subjectKind: "user", subjectId: "U0BOB" })] : []));
    const g = setup();
    await g.deliver("A0MAIN", "U0BOB", "CELSEWHERE", "hello");
    expect(g.turns).toHaveLength(0);
    await g.deliver("A0ALPHA", "U0BOB", "CELSEWHERE", "hello");
    expect(g.turns).toHaveLength(1);
  });
});
