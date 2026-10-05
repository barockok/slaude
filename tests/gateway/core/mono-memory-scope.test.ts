/**
 * Episodic memory in mono (the agent runs in the gateway's process). The
 * in-process provider must scope every turn by the turn's own context, the
 * same memoryScopeFor the gateway's memory routes use for node turns: a named
 * persona's turn lands in ITS slice, never the process slice; a /1on1 in the
 * user's; a job created inside a 1:1 runs as the user; a manager speaking in
 * someone else's locked thread reads and writes nothing.
 *
 * Before the fix the mono path used the process-wide agentScope(), so every
 * persona's turns (1:1s included) were written to the default persona's slice.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createGateway } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import { db } from "../../../src/db/schema";
import * as CronJobs from "../../../src/db/cron-jobs";
import * as OneOnOne from "../../../src/db/one-on-one";
import * as Sessions from "../../../src/db/sessions";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { SimSession } from "../../../src/gateway/sim/engine";
import { __resetPersonaRegistry, setPersonaRegistry } from "../../../src/persona/registry";
import { __setMemoryForTests, memory as originalMemory } from "../../../src/memory";
import type { MemoryProvider } from "../../../src/memory/provider";
import { BrainMemoryProvider } from "../../../src/memory/brain-provider";
import { resetAgentId, setAgentId } from "../../../src/knowledge/agent-identity";
import { agentSourceId, userSourceId } from "../../../src/knowledge/scope";
import { fakeBrain } from "../../memory/fake-brain";
import { closeBrain } from "../../../src/knowledge/brain";

const PROCESS_ID = "U_SLAUDE";
const PERSONA_SLACK_ID = "U0FIN";

const managedRegistry = () => {
  const finance = {
    name: "finance", slackUserId: PERSONA_SLACK_ID, soulMd: "finance soul",
    config: { slackUserId: PERSONA_SLACK_ID, name: "finance" }, outClient: null, model: null, mcp: null, kbSources: null,
  };
  return {
    lookupByUserId: (id: string) => (id === PERSONA_SLACK_ID ? finance : null),
    lookupByName: (n: string) => (n === "finance" ? finance : null),
    list: () => [finance],
    isMultiPersonaMode: () => true,
    isManaged: () => true,
    tombstonedPersonaFor: () => null,
    defaultPersona: () => ({ model: null, mcp: null, kbSources: null }),
  } as any;
};

function fakeTransport() {
  return {
    client: {
      auth: { test: async () => ({ user_id: PROCESS_ID, bot_id: "B_SLAUDE", team: "T", url: "x" }) },
      chat: { postMessage: async () => ({ ok: true, ts: "1" }), update: async () => ({ ok: true }) },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
      users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
      search: { messages: async () => ({}) },
    },
    action: () => {}, event: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
  } as any;
}

/** Capture the provider createGateway installs on its agent. */
let installed: MemoryProvider | null = null;
const origSet = AgentManager.prototype.setMemoryProvider;
AgentManager.prototype.setMemoryProvider = function (p: MemoryProvider) {
  installed = p;
  return origSet.call(this, p);
};
const mem = (): MemoryProvider => {
  if (!installed) throw new Error("createGateway installed no scoped memory provider on its agent");
  return installed;
};

let fb: ReturnType<typeof fakeBrain>;
beforeEach(async () => {
  installed = null;
  fb = fakeBrain();
  __setMemoryForTests(new BrainMemoryProvider({ call: fb.call, ready: async () => {} }));
  setAgentId(PROCESS_ID);
  writeSoulFixture(WORLD);
  await OneOnOne._wipeForTests();
});
afterEach(async () => {
  await db.run("DELETE FROM cron_jobs");
  __resetPersonaRegistry();
});
afterAll(async () => {
  AgentManager.prototype.setMemoryProvider = origSet;
  __setMemoryForTests(originalMemory);
  resetAgentId();
  // The gateways and sim sessions above may boot the process brain (embedded
  // PGLite); left open it keeps working in the background and slows the next
  // file's timing-sensitive tests.
  await closeBrain();
});

async function cronSession(opts: { personaId?: string; oauthUser?: string; threadTs: string }) {
  const agent = new AgentManager();
  agent.sendMessage = async () => {};
  const job = await CronJobs.create({
    slackTeamId: "T", slackChannelId: "C0TEAM", slackThreadTs: opts.threadTs, channelId: "C0TEAM",
    createdBy: "U0MEMBER", cronExpr: "* * * * *", prompt: "tick", nextRunAt: Date.now() - 1000, target: "thread",
    ...(opts.personaId ? { personaId: opts.personaId } : {}),
    ...(opts.oauthUser ? { oauthUser: opts.oauthUser } : {}),
  });
  const h = createGateway(agent, fakeTransport());
  await new Promise((r) => setTimeout(r, 80)); // the due job registers its route
  const session = await agent.ensureSession({
    team_id: "T", channel_id: "C0TEAM", thread_ts: opts.threadTs,
    ...(opts.personaId ? { persona_id: opts.personaId } : {}),
  });
  return { h, session, job };
}

describe("mono memory is scoped by the turn's own context", () => {
  test("a named persona's turn lands in its own slice, never the process (default persona) slice", async () => {
    setPersonaRegistry(managedRegistry());
    const { h, session } = await cronSession({ personaId: "finance", threadTs: "T-FIN" });
    try {
      await mem().syncTurn({ sessionId: session.id, user: "finance question", assistant: "a" });
      expect(fb.sourcesOf(session.id)).toEqual([agentSourceId(PERSONA_SLACK_ID)]);
      expect(await mem().prefetch(session.id)).toContain("finance question");
    } finally {
      await h.stop();
    }
  });

  test("a job created inside a 1:1 runs as the user: the user's slice, not the persona's", async () => {
    const { h, session } = await cronSession({ oauthUser: "U0MEMBER", threadTs: "T-CRON-1ON1" });
    try {
      expect(await OneOnOne.find("C0TEAM", "T-CRON-1ON1")).toBeNull();
      await mem().syncTurn({ sessionId: session.id, user: "private", assistant: "a" });
      expect(fb.sourcesOf(session.id)).toEqual([userSourceId("U0MEMBER")]);
    } finally {
      await h.stop();
    }
  });

  test("a session with no route reads and writes nothing", async () => {
    const agent = new AgentManager();
    const h = createGateway(agent, fakeTransport());
    try {
      fb.seed(agentSourceId(PROCESS_ID), "S-unrouted", "earlier turn");
      await mem().syncTurn({ sessionId: "S-unrouted-2", user: "u", assistant: "a" });
      expect(fb.sourcesOf("S-unrouted-2")).toEqual([]);
      expect(await mem().prefetch("S-unrouted")).toBeNull();
    } finally {
      await h.stop();
    }
  });
});

describe("mono privacy matrix (interactive turns)", () => {
  const sessionOf = async (thread: string) =>
    (await Sessions.findByThread({ team_id: "T0SIM", channel_id: "C0TEAM", thread_ts: thread }))!.id;

  test("trusted channel: the persona's slice; the owner's /1on1: the user's slice; a manager in that locked thread: nothing", async () => {
    const s = await SimSession.create({ agent: "stub", layer: "trusted", as: "member" });
    try {
      s.thread = "T-OPEN";
      await s.send({ text: "hello" });
      const open = await sessionOf("T-OPEN");
      await mem().syncTurn({ sessionId: open, user: "open turn", assistant: "a" });
      expect(fb.sourcesOf(open)).toEqual([agentSourceId(PROCESS_ID)]);

      s.thread = "T-LOCKED";
      await s.send({ text: "/1on1" });
      await s.send({ text: "private question" });
      const locked = await sessionOf("T-LOCKED");
      const member = (await OneOnOne.find("C0TEAM", "T-LOCKED"))!.locked_user;
      await mem().syncTurn({ sessionId: locked, user: "private question", assistant: "a" });
      expect(fb.sourcesOf(locked)).toEqual([userSourceId(member)]);

      // The manager now speaks in the member's locked thread: the route's
      // speaker is the manager. Nothing written, and the 1:1 is not read.
      await s.send({ as: WORLD.manager, text: "manager here" });
      const before = JSON.stringify([...fb.pages.entries()]);
      await mem().syncTurn({ sessionId: locked, user: "manager here", assistant: "a" });
      expect(JSON.stringify([...fb.pages.entries()])).toBe(before);
      expect(fb.sourcesOf(locked)).not.toContain(agentSourceId(PROCESS_ID));
      expect(await mem().prefetch(locked)).toBeNull();
    } finally {
      await s.dispose();
    }
  });
});
