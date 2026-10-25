/**
 * kb_thread_history on a REAL gateway's /v1 path: the read scope comes from the
 * job token (signed lock and runAs), through the same function the memory
 * routes use, not from live state that can differ per replica or change
 * mid-turn.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createGateway, type GatewayHandle } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { mintJobToken, JOB_HEADER, type JobClaims } from "../../../src/gateway/api/auth";
import { ensureHome } from "../../../src/config/home";
import { setBackendForTest, resetBackend } from "../../../src/knowledge/backend";
import { __resetPersonaRegistry, setPersonaRegistry } from "../../../src/persona/registry";
import { agentSourceId, userSourceId, type BrainScope } from "../../../src/knowledge/scope";
import { THREAD_HISTORY_REFUSAL } from "../../../src/knowledge/mcp-tools";
import * as OneOnOne from "../../../src/db/one-on-one";

const NODE_TOKEN = "thread-history-node-token";
const ENV = ["SLAUDE_NODE_TOKEN", "SLAUDE_JOB_SECRET", "SLAUDE_BRAIN_MODE", "SLAUDE_BRAIN_DISABLED"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const PERSONA_SLACK_ID = "U0FIN";

let reads: { slug: unknown; scope: BrainScope }[] = [];
const backend = {
  call: async (name: string, p: Record<string, unknown>, scope: BrainScope) => {
    if (name !== "get_timeline") return [];
    reads.push({ slug: p.slug, scope });
    return [{ id: 1, date: "2026-10-01", summary: "q", detail: "<user>hello</user>\n<assistant>hi</assistant>" }];
  },
  adminCall: async () => null,
};

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

const registry = () => {
  const finance = {
    name: "finance", slackUserId: PERSONA_SLACK_ID, soulMd: "finance soul",
    config: { slackUserId: PERSONA_SLACK_ID, name: "finance" }, outClient: null, model: null, mcp: null, kbSources: null,
  };
  return {
    lookupByUserId: (id: string) => (id === PERSONA_SLACK_ID ? finance : null),
    lookupByName: (n: string) => (n === "finance" ? finance : null),
    list: () => [finance], isMultiPersonaMode: () => true, isManaged: () => true,
    tombstonedPersonaFor: () => null, defaultPersona: () => ({ model: null, mcp: null, kbSources: null }),
  } as any;
};

let handle: GatewayHandle;
beforeAll(() => {
  process.env.SLAUDE_NODE_TOKEN = NODE_TOKEN;
  process.env.SLAUDE_JOB_SECRET = "thread-history-job-secret";
  process.env.SLAUDE_BRAIN_MODE = "remote";
  delete process.env.SLAUDE_BRAIN_DISABLED;
  setBackendForTest(backend);
  ensureHome();
  writeSoulFixture(WORLD);
  handle = createGateway(new AgentManager(), fakeTransport());
});
afterAll(async () => {
  await handle.stop();
  resetBackend();
  __resetPersonaRegistry();
  await OneOnOne._wipeForTests();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(async () => {
  reads = [];
  setPersonaRegistry(registry());
  await OneOnOne._wipeForTests();
});

async function history(c: Partial<JobClaims>) {
  const token = mintJobToken({
    tenant: "default", persona: "finance", session: "S-Hist", team: "T1", channel: "C0TEAM", thread: "700.0",
    initiator: "U0ALICE", scope: "turn", ...c,
  });
  const res = (await handle.fetchV1(new Request("http://gw/v1/tools/kb/kb_thread_history", {
    method: "POST",
    headers: { authorization: `Bearer ${NODE_TOKEN}`, [JOB_HEADER]: token, "content-type": "application/json" },
    body: "{}",
  })))!;
  expect(res.status).toBe(200);
  return ((await res.json()) as any).content[0].text as string;
}

describe("kb_thread_history on /v1 reads by the job token", () => {
  test("an ordinary turn reads this session's page in the persona's slice", async () => {
    const out = await history({});
    expect(out).toContain("[2026-10-01] user: hello");
    expect(reads).toHaveLength(1);
    expect(reads[0]!.slug).toBe("conversations/s-hist");
    expect(reads[0]!.scope.sourceId).toBe(agentSourceId(PERSONA_SLACK_ID));
  });

  test("(a) dispatched in someone else's /1on1 that is gone by now: refused like the memory routes, nothing read", async () => {
    // No live lock exists (the owner ran /1on1 off mid-turn); the token still names it.
    const out = await history({ lock: { user: "U0BOB", openScope: null } });
    expect(out).toBe(THREAD_HISTORY_REFUSAL);
    expect(reads).toHaveLength(0);
  });

  test("(c) a cron created in a /1on1 reads the user's slice from the signed runAs, with no live lock or cron map", async () => {
    const out = await history({ runAs: "user:U0ALICE" });
    expect(out).toContain("[2026-10-01] assistant: hi");
    expect(reads).toHaveLength(1);
    expect(reads[0]!.scope.sourceId).toBe(userSourceId("U0ALICE"));
  });
});
