/**
 * Episodic memory on a node (the release-blocking follow-up of the Secret
 * split). A node holds no database or brain, so its manager's memory provider
 * is a REST client of the gateway's /v1/tools/memory routes; the gateway runs
 * the provider with the persona's own agent id and the scope it derives from
 * the job token.
 *
 * Boots a node-role AgentManager (SLAUDE_ROLE=node, SLAUDE_DB=pg, no URL) with
 * a fake claude-agent-sdk `query`, wired to a real createV1Api through
 * NodeClient's injectable fetch. Also covers mixed versions: a gateway without
 * the routes (404), and a refusal (label gate 403): logged once, the turn runs.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realSdk = await import("@anthropic-ai/claude-agent-sdk");
const realQuery = realSdk.query;
type QueryArgs = { prompt: AsyncIterable<any>; options: any };
let captured: any[] = [];
let fakeActive = false;
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  ...realSdk,
  query: (args: QueryArgs) => {
    if (!fakeActive) return realQuery(args as any);
    captured.push(args.options);
    return {
      async *[Symbol.asyncIterator]() {
        for await (const _ of args.prompt) {
          yield { type: "assistant", message: { content: [{ type: "text", text: "the reply" }] } };
          yield { type: "result", subtype: "success", is_error: false };
        }
      },
      setPermissionMode: async () => ({}),
      mcpServerStatus: async () => [],
      interrupt: async () => {},
    };
  },
}));

const { AgentManager } = await import("../../src/agent/manager");
const { createV1Api } = await import("../../src/gateway/api");
const { __setNodeVerifier, mintJobToken } = await import("../../src/gateway/api/auth");
const { mintNodeCredential, NodeCredentialVerifier } = await import("../../src/gateway/auth/node-credential");
const { InMemoryPendingSource } = await import("../../src/gateway/api/pending-source");
const { makeMemoryPlane } = await import("../../src/gateway/api/memory");
const { BrainMemoryProvider } = await import("../../src/memory/brain-provider");
const { NodeClient } = await import("../../src/node/client");
const { makeNodeMemoryProvider } = await import("../../src/node/memory");
const { lockFromClaims } = await import("../../src/node/session-lock");
const { agentSourceId } = await import("../../src/knowledge/scope");
const { fakeBrain } = await import("../memory/fake-brain");

const ENV = [
  "SLAUDE_ROLE", "SLAUDE_DB", "SLAUDE_PG_URL", "SLAUDE_AUTO_EVOLVE", "SLAUDE_IDLE_MINUTES",
  "SLAUDE_NODE_KEY", "SLAUDE_JOB_SECRET", "SLAUDE_NODE_TOKEN", "SLAUDE_NODE_LEGACY_TOKEN", "SLAUDE_NODE_LEGACY",
] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
beforeAll(() => {
  fakeActive = true;
  process.env.SLAUDE_ROLE = "node";
  process.env.SLAUDE_DB = "pg";
  delete process.env.SLAUDE_PG_URL;
  process.env.SLAUDE_AUTO_EVOLVE = "0";
  process.env.SLAUDE_IDLE_MINUTES = "0";
  delete process.env.SLAUDE_NODE_TOKEN;
  delete process.env.SLAUDE_NODE_LEGACY;
  delete process.env.SLAUDE_NODE_LEGACY_TOKEN;
  process.env.SLAUDE_NODE_KEY = "node-memory-key";
  process.env.SLAUDE_JOB_SECRET = "node-memory-job-secret";
  __setNodeVerifier(new NodeCredentialVerifier({ revocations: async () => null }));
});
afterAll(() => {
  fakeActive = false;
  __setNodeVerifier(null);
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function fakeStore(persona: string) {
  const rows = new Map<string, any>();
  return {
    async findById(id: string) { return rows.get(id) ?? null; },
    async findByThread(k: any) {
      for (const r of rows.values()) if (r.slack_channel_id === k.channel_id && r.slack_thread_ts === k.thread_ts) return r;
      return null;
    },
    async createForThread(a: any) {
      const r = {
        id: `s-${persona}-${rows.size + 1}`, created_at: 0, updated_at: 0, title: null, model: a.model, working_dir: a.working_dir,
        status: "idle", claude_started: 0, slack_team_id: a.thread.team_id, slack_channel_id: a.thread.channel_id,
        slack_thread_ts: a.thread.thread_ts, permission_mode: "default", engaged: 1, persona_id: persona,
      };
      rows.set(r.id, r);
      return r;
    },
    async markStarted() {}, async clearStarted() {}, async setStatus() {}, async setPermissionMode() {}, async setModel() {},
  };
}

async function until(cond: () => boolean, label: string, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`);
    await Bun.sleep(5);
  }
}

/** Persona → its Slack user id (what brainGateFor resolves on the gateway). */
const PERSONA_IDS: Record<string, string> = { finance: "U0FINANCE" };

/** A gateway /v1 with a memory plane over a fake brain; `memory: null` = an older gateway. */
function gateway(opts: { serveMemory?: boolean } = {}) {
  const fb = fakeBrain();
  const provider = new BrainMemoryProvider({ call: fb.call, ready: async () => {} });
  const v1 = createV1Api({
    tools: {} as any,
    pendingSource: new InMemoryPendingSource(),
    memory:
      opts.serveMemory === false
        ? null
        : makeMemoryPlane({
            provider,
            gateFor: async (c) => ({
              userId: c.initiator || null,
              lockedUser: c.lock?.user ?? null,
              channelTrust: "trusted",
              isManager: false,
              agentId: PERSONA_IDS[c.persona] ?? "default",
            }),
          }),
  });
  return { fb, v1 };
}

/** A node-role manager wired like the worker: memory through the gateway. */
async function nodeSession(v1: { fetch(r: Request): Promise<Response | null> }, labels: string[]) {
  captured = [];
  const client = new NodeClient({
    baseUrl: "http://gw",
    token: mintNodeCredential({ id: "node-1", labels }, { key: "node-memory-key" }),
    attempts: 1,
    fetchImpl: (async (url: string, init: RequestInit) => (await v1.fetch(new Request(url, init)))!) as any,
  });
  const warnings: string[] = [];
  const mgr = new AgentManager();
  const events: any[] = [];
  mgr.on("event", (e: any) => events.push(e));
  mgr.setSessionStore(fakeStore("finance") as any);
  mgr.setPersonaSoulResolver(async () => ({ soulMd: "node soul", soulJson: null }));
  const dir = mkdtempSync(join(tmpdir(), "slaude-node-memory-"));
  mgr.setSessionConfigDirResolver(async () => dir);
  let tok = "";
  mgr.setSessionLockResolver(async (sid) => lockFromClaims({ tokenFor: () => tok }, sid));
  mgr.setMemoryProvider(makeNodeMemoryProvider({ client, tokenFor: () => tok, warn: (m) => warnings.push(m) }));
  const row = await mgr.ensureSession({ team_id: "T1", channel_id: "C1", thread_ts: "1.1" });
  tok = mintJobToken({
    tenant: "default", persona: "finance", session: row.id, team: "T1", channel: "C1", thread: "1.1",
    initiator: "U1", scope: "turn", job: "J1", runAs: "agent", label: "finance", lock: null,
  });
  const turn = async (text: string) => {
    const done = events.filter((e) => e.type === "done" || e.type === "error").length;
    await mgr.sendMessage(row.id, text);
    await until(() => events.filter((e) => e.type === "done" || e.type === "error").length > done, "turn end");
  };
  return { mgr, row, turn, events, warnings };
}

describe("node memory served by the gateway", () => {
  it("the node gets <memory-context> from the gateway, and its turn is written under the persona's own slice", async () => {
    const { fb, v1 } = gateway();
    const s = await nodeSession(v1, ["finance"]);
    fb.seed(agentSourceId("U0FINANCE"), s.row.id, "<user>earlier question</user>");
    await s.turn("hello from the node");
    expect(captured[0].systemPrompt.append).toContain("<memory-context>");
    expect(captured[0].systemPrompt.append).toContain("earlier question");
    await until(() => (fb.pages.get(`${agentSourceId("U0FINANCE")}\u0000conversations/${s.row.id}`)?.length ?? 0) > 1, "sync");
    expect(fb.sourcesOf(s.row.id)).toEqual([agentSourceId("U0FINANCE")]);
    const rows = fb.pages.get(`${agentSourceId("U0FINANCE")}\u0000conversations/${s.row.id}`)!;
    expect(rows.at(-1)!.detail).toContain("hello from the node");
    expect(rows.at(-1)!.detail).toContain("the reply");
    expect(s.warnings).toEqual([]);
    expect(s.events.some((e) => e.type === "error")).toBe(false);
    s.mgr.reload(s.row.id);
  });

  it("an older gateway without the routes: logged once, the turns run without memory", async () => {
    const { v1 } = gateway({ serveMemory: false });
    const s = await nodeSession(v1, ["finance"]);
    await s.turn("one");
    await s.turn("two");
    await Bun.sleep(20);
    expect(captured[0].systemPrompt.append).not.toContain("<memory-context>");
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]).toContain("older gateway");
    expect(s.events.some((e) => e.type === "error")).toBe(false);
    s.mgr.reload(s.row.id);
  });

  it("a node without the persona's label is refused (403): logged once per operation, the turn runs", async () => {
    const { fb, v1 } = gateway();
    const s = await nodeSession(v1, ["engineering"]);
    await s.turn("one");
    await s.turn("two");
    await until(() => s.warnings.length >= 2, "warnings");
    expect(s.warnings.every((w) => w.includes("HTTP 403"))).toBe(true);
    expect(s.warnings).toHaveLength(2); // prefetch once, sync once
    expect(fb.pages.size).toBe(0);
    expect(s.events.some((e) => e.type === "error")).toBe(false);
    s.mgr.reload(s.row.id);
  });
});

describe("makeNodeMemoryProvider", () => {
  it("a network failure resolves (null / no-op) and is logged once", async () => {
    const warnings: string[] = [];
    const p = makeNodeMemoryProvider({
      client: {
        memoryPrefetch: async () => { throw new Error("connect ECONNREFUSED"); },
        memorySync: async () => { throw new Error("connect ECONNREFUSED"); },
      },
      tokenFor: () => "tok",
      warn: (m) => warnings.push(m),
    });
    expect(await p.prefetch("s")).toBeNull();
    expect(await p.prefetch("s")).toBeNull();
    await p.syncTurn({ sessionId: "s", user: "u", assistant: "a" });
    expect(warnings).toHaveLength(2);
  });

  it("no job token: skipped without a call", async () => {
    let calls = 0;
    const p = makeNodeMemoryProvider({
      client: { memoryPrefetch: async () => (calls++, null), memorySync: async () => (calls++, "ok") },
      tokenFor: () => undefined,
      warn: () => {},
    });
    expect(await p.prefetch("s")).toBeNull();
    await p.syncTurn({ sessionId: "s", user: "u", assistant: "a" });
    expect(calls).toBe(0);
  });
});
