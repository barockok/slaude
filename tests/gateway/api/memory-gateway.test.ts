/**
 * The memory routes on a REAL gateway (createGateway): the slice comes from the
 * gateway's own brainGateFor, which resolves a named persona's agent id from
 * the live persona's slackUserId, and its /1on1 lock from the database. No
 * hand-written persona→id stub: if brainGateFor stopped using the persona's
 * identity, a named persona's memory would land in the process slice and this
 * file fails.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createGateway, type GatewayHandle } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { mintJobToken, JOB_HEADER, type JobClaims } from "../../../src/gateway/api/auth";
import { ensureHome } from "../../../src/config/home";
import { __resetPersonaRegistry, setPersonaRegistry } from "../../../src/persona/registry";
import { __setMemoryForTests, memory as originalMemory } from "../../../src/memory";
import { BrainMemoryProvider } from "../../../src/memory/brain-provider";
import { agentSourceId, userSourceId } from "../../../src/knowledge/scope";
import * as OneOnOne from "../../../src/db/one-on-one";
import { fakeBrain } from "../../memory/fake-brain";

const NODE_TOKEN = "memory-gw-node-token";
const ENV = ["SLAUDE_NODE_TOKEN", "SLAUDE_JOB_SECRET", "SLAUDE_BRAIN_MODE", "SLAUDE_BRAIN_DISABLED", "SLAUDE_AGENT_ID"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

function fakeTransport(): Transport {
  return {
    client: {
      auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
      chat: { postMessage: async () => ({ ok: true, ts: "1.1" }), update: async () => ({ ok: true }) },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      conversations: { info: async () => ({}), members: async () => ({ members: [] }), replies: async () => ({ messages: [] }) },
      users: { info: async () => ({ user: { real_name: "Test" } }) },
    } as any,
    action: () => {}, event: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
  };
}

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

let handle: GatewayHandle;
let fb: ReturnType<typeof fakeBrain>;
beforeAll(() => {
  process.env.SLAUDE_NODE_TOKEN = NODE_TOKEN;
  process.env.SLAUDE_JOB_SECRET = "memory-gw-job-secret";
  process.env.SLAUDE_BRAIN_MODE = "remote"; // no local brain bootstrap in this process
  delete process.env.SLAUDE_BRAIN_DISABLED;
  delete process.env.SLAUDE_AGENT_ID;
  ensureHome();
  writeSoulFixture(WORLD);
  handle = createGateway(new AgentManager(), fakeTransport());
});
afterAll(async () => {
  __setMemoryForTests(originalMemory);
  __resetPersonaRegistry();
  await OneOnOne._wipeForTests();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(async () => {
  fb = fakeBrain();
  __setMemoryForTests(new BrainMemoryProvider({ call: fb.call, ready: async () => {} }));
  setPersonaRegistry(managedRegistry());
  await OneOnOne._wipeForTests();
});

async function sync(c: Partial<JobClaims>) {
  const token = mintJobToken({
    tenant: "default", persona: "finance", session: "S-gw", team: "T1", channel: "C0TEAM", thread: "500.0",
    initiator: "U0MEMBER", scope: "turn", ...c,
  });
  const res = (await handle.fetchV1(new Request("http://gw/v1/tools/memory/sync", {
    method: "POST",
    headers: { authorization: `Bearer ${NODE_TOKEN}`, [JOB_HEADER]: token, "content-type": "application/json" },
    body: JSON.stringify({ user: "q", assistant: "a" }),
  })))!;
  return res.status;
}

describe("memory on a real gateway", () => {
  test("a named persona's turn lands in its own agent-<slackUserId> slice, never agent-default or the process slice", async () => {
    expect(await sync({})).toBe(200);
    expect(fb.sourcesOf("S-gw")).toEqual([agentSourceId(PERSONA_SLACK_ID)]);
    expect(fb.sourcesOf("S-gw")).not.toContain(agentSourceId("default"));
    expect(fb.sourcesOf("S-gw")).not.toContain(agentSourceId("U_SLAUDE"));
  });

  test("the thread's live /1on1 lock (from the database) puts the owner's turn in the user's slice", async () => {
    await OneOnOne.lock({ channelId: "C0TEAM", threadTs: "500.0", lockedUser: "U0MEMBER", createdBy: "U0MEMBER" });
    expect(await sync({ session: "S-gw-1on1" })).toBe(200);
    expect(fb.sourcesOf("S-gw-1on1")).toEqual([userSourceId("U0MEMBER")]);
  });

  test("a retired persona's job is a 409, nothing written", async () => {
    expect(await sync({ persona: "ghost", session: "S-ghost" })).toBe(409);
    expect(fb.pages.size).toBe(0);
  });
});
