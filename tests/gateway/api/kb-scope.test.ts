/**
 * Per-persona knowledge scope, enforced on the gateway (WS-C §4.1.3, §4.1.4):
 * brainDepsFor intersects the LIVE persona's kbSources with the installed KBs,
 * per call, and both the REST tool plane and the in-process MCP use it.
 * list_kbs and search_kbs take the same filtered list and return no disk path.
 *
 * A real createGateway over a recording brain backend (remote mode, so the
 * gateway runs no local brain bootstrap) and a managed persona registry.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createGateway, type GatewayHandle } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { mintJobToken, JOB_HEADER } from "../../../src/gateway/api/auth";
import { ensureHome, paths } from "../../../src/config/home";
import { clearKbCache } from "../../../src/knowledge/loader";
import { setBackendForTest, resetBackend } from "../../../src/knowledge/backend";
import { __resetPersonaRegistry, setPersonaRegistry } from "../../../src/persona/registry";
import type { BrainScope } from "../../../src/knowledge/scope";

const NODE_TOKEN = "kb-scope-node-token";
const ENV = ["SLAUDE_NODE_TOKEN", "SLAUDE_JOB_SECRET", "SLAUDE_BRAIN_MODE", "SLAUDE_BRAIN_DISABLED"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

/** Every per-source search the gather fanned out, by source. */
let searched: string[] = [];
const backend = {
  call: async (name: string, _p: Record<string, unknown>, scope: BrainScope) => {
    if (name === "search") searched.push(scope.sourceId);
    return [];
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
    action: () => {}, event: (name: string, fn: any) => handlers.set(name, fn), use: () => {}, start: async () => {}, stop: async () => {},
  };
}
const handlers = new Map<string, (args: any) => Promise<void>>();
/** Session ids the gateway handed to the (stubbed) agent, in order. */
const sent: string[] = [];

/** A managed registry: finance reads kb-finance only, closed reads nothing,
 *  the default persona reads every installed KB (kbSources null). */
let kbOf: Record<string, string[] | null> = {};
const PERSONAS = ["finance", "closed", "open"];
function managedRegistry() {
  const persona = (n: string) => ({
    name: n, slackUserId: `U${n.toUpperCase()}`, soulMd: `${n} soul`,
    config: { slackUserId: `U${n.toUpperCase()}`, name: n }, outClient: null, model: null, mcp: null, kbSources: kbOf[n] ?? null,
  });
  return {
    lookupByUserId: () => null,
    lookupByName: (n: string) => (PERSONAS.includes(n) ? persona(n) : null),
    list: () => PERSONAS.map(persona),
    isMultiPersonaMode: () => true,
    isManaged: () => true,
    tombstonedPersonaFor: () => null,
    defaultPersona: () => ({ model: null, mcp: null, kbSources: kbOf.default ?? null }),
  } as any;
}

let handle: GatewayHandle;
beforeAll(() => {
  process.env.SLAUDE_NODE_TOKEN = NODE_TOKEN;
  process.env.SLAUDE_JOB_SECRET = "kb-scope-job-secret";
  process.env.SLAUDE_BRAIN_MODE = "remote";
  delete process.env.SLAUDE_BRAIN_DISABLED;
  setBackendForTest(backend);
  ensureHome();
  writeSoulFixture(WORLD);
  const agent = new AgentManager();
  agent.sendMessage = async (id: string) => void sent.push(id);
  handle = createGateway(agent, fakeTransport());
});
afterAll(async () => {
  await handle.stop();
  // Shared test home: KBs left behind would be imported by every later gateway.
  rmSync(paths.knowledge, { recursive: true, force: true });
  clearKbCache();
  resetBackend();
  __resetPersonaRegistry();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(() => {
  if (existsSync(paths.knowledge)) rmSync(paths.knowledge, { recursive: true, force: true });
  for (const [label, tags] of [["finance", "budget"], ["runbook", "budget"]] as const) {
    mkdirSync(join(paths.knowledge, label), { recursive: true });
    writeFileSync(join(paths.knowledge, label, "README.md"), `---\ndescription: ${label} wiki\ntags:\n  - ${tags}\n---\n# ${label}\n`);
  }
  clearKbCache();
  kbOf = { finance: ["kb-finance", "kb-not-installed"], closed: [], open: null, default: null };
  setPersonaRegistry(managedRegistry());
  searched = [];
});

async function tool(persona: string, name: string, body: unknown) {
  const token = mintJobToken({
    tenant: "default", persona, session: `S-kb-${persona}`, team: "T1", channel: "C0TEAM", thread: "300.0",
    initiator: WORLD.manager, scope: "turn",
  });
  const res = (await handle.fetchV1(new Request(`http://gw/v1/tools/kb/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${NODE_TOKEN}`, [JOB_HEADER]: token, "content-type": "application/json" },
    body: JSON.stringify(body),
  })))!;
  expect(res.status).toBe(200);
  return ((await res.json()) as any).content[0].text as string;
}

const kbSearched = () => searched.filter((s) => s.startsWith("kb-")).sort();

describe("kb_search gathers only the persona's kb-* sources", () => {
  test("a list: only those, intersected with what is installed", async () => {
    await tool("finance", "kb_search", { query: "budget" });
    expect(kbSearched()).toEqual(["kb-finance"]);
    // Its own slice, shared and public keep their rules.
    expect(searched).toEqual(expect.arrayContaining(["shared", "public"]));
  });

  test("[]: no kb-* source at all", async () => {
    await tool("closed", "kb_search", { query: "budget" });
    expect(kbSearched()).toEqual([]);
    expect(searched).toEqual(expect.arrayContaining(["shared", "public"]));
  });

  test("null (named persona and the default persona): every installed KB", async () => {
    await tool("open", "kb_search", { query: "budget" });
    expect(kbSearched()).toEqual(["kb-finance", "kb-runbook"]);
    searched = [];
    await tool("default", "kb_search", { query: "budget" });
    expect(kbSearched()).toEqual(["kb-finance", "kb-runbook"]);
  });

  test("computed per call: a new registry (a sync) applies to the next call", async () => {
    await tool("finance", "kb_search", { query: "budget" });
    expect(kbSearched()).toEqual(["kb-finance"]);
    kbOf.finance = ["kb-runbook"];
    setPersonaRegistry(managedRegistry());
    searched = [];
    await tool("finance", "kb_search", { query: "budget" });
    expect(kbSearched()).toEqual(["kb-runbook"]);
  });
});

describe("list_kbs and search_kbs are persona-filtered and path-free", () => {
  test("list_kbs lists only the persona's KBs, with no disk path", async () => {
    const finance = JSON.parse(await tool("finance", "list_kbs", {}));
    expect(finance.map((k: any) => k.label)).toEqual(["finance"]);
    for (const k of finance) {
      expect(Object.keys(k).sort()).toEqual(["description", "label", "source", "tags"]);
      expect(JSON.stringify(k)).not.toContain(paths.knowledge);
    }
    expect(await tool("closed", "list_kbs", {})).toBe("(no knowledge bases available)");
    expect(JSON.parse(await tool("open", "list_kbs", {})).map((k: any) => k.label).sort()).toEqual(["finance", "runbook"]);
  });

  test("search_kbs cannot reveal a KB the persona may not read", async () => {
    const hits = JSON.parse(await tool("finance", "search_kbs", { query: "budget" }));
    expect(hits.map((k: any) => k.label)).toEqual(["finance"]);
    expect(JSON.stringify(hits)).not.toContain(paths.knowledge);
    expect(await tool("closed", "search_kbs", { query: "budget" })).toBe("(no knowledge bases available)");
  });
});

describe("a retired persona", () => {
  test("its KB tool calls are a 409 with one log line, never a retried 500", async () => {
    for (const name of ["list_kbs", "search_kbs", "kb_search"]) {
      const lines: unknown[][] = [];
      const warn = console.warn; const error = console.error;
      console.warn = (...a: unknown[]) => void lines.push(a);
      console.error = (...a: unknown[]) => void lines.push(a);
      let status = 0; let body: any;
      try {
        const token = mintJobToken({
          tenant: "default", persona: "ghost", session: "S-ghost", team: "T1", channel: "C0TEAM", thread: "300.0",
          initiator: WORLD.manager, scope: "turn",
        });
        const res = (await handle.fetchV1(new Request(`http://gw/v1/tools/kb/${name}`, {
          method: "POST",
          headers: { authorization: `Bearer ${NODE_TOKEN}`, [JOB_HEADER]: token, "content-type": "application/json" },
          body: JSON.stringify(name === "list_kbs" ? {} : { query: "budget" }),
        })))!;
        status = res.status; body = await res.json();
      } finally { console.warn = warn; console.error = error; }
      expect({ name, status, code: body.code }).toEqual({ name, status: 409, code: "PERSONA_NOT_LIVE" });
      expect(lines).toHaveLength(1);
    }
  });
});

// mono: the in-process slaude_kb server the gateway mounts for a session takes
// the session persona's list too, not only the REST plane.
describe("the in-process slaude_kb server (mono)", () => {
  async function callTool(cfg: any, name: string, args: Record<string, unknown>) {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await cfg.instance.connect(serverT);
    const client = new Client({ name: "t", version: "0.0.0" });
    await client.connect(clientT);
    try {
      return (await client.callTool({ name, arguments: args })) as any;
    } finally {
      await client.close();
    }
  }

  test("list_kbs and search_kbs list only the session persona's KBs", async () => {
    kbOf.default = ["kb-finance"];
    setPersonaRegistry(managedRegistry());
    sent.length = 0;
    await handlers.get("message")!({
      event: { type: "message", channel: "D0MGR", channel_type: "im", user: WORLD.manager, team: "T", ts: "8100.1", text: "hello" },
      client: fakeTransport().client,
      context: { teamId: "T" },
    });
    const t0 = Date.now();
    while (sent.length === 0 && Date.now() - t0 < 3000) await Bun.sleep(10);
    const servers = (await handle.__resolveMcp(sent[0]!))!;
    const kb = servers["slaude_kb"];
    const list = JSON.parse((await callTool(kb, "list_kbs", {})).content[0].text);
    expect(list.map((k: any) => k.label)).toEqual(["finance"]);
    const hits = JSON.parse((await callTool(kb, "search_kbs", { query: "budget" })).content[0].text);
    expect(hits.map((k: any) => k.label)).toEqual(["finance"]);
  });
});
