/**
 * How the gateway delivers a channel wake and a promise check: the wake's turn
 * goes into its channel session, in that session's folder, and carries its caps
 * and its root-post claims; a promise check in a thread of the shared proactive
 * folder is deferred while another session holds the folder.
 */
import { channelWorkspaceDir, isProactiveWorkspace, proactiveWorkspaceDir } from "../../src/agent/workspace-claim";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Sessions from "../../src/db/sessions";
import * as OneOnOne from "../../src/db/one-on-one";
import { createGateway, type GatewayHandle } from "../../src/gateway/core/gateway";
import * as RedisConn from "../../src/queue/redis";
import { AgentManager, type BackgroundTurnRun, type InputSender } from "../../src/agent/manager";
import type { DispatchMeta, QueueDispatch } from "../../src/gateway/core/dispatch";
import { writeSoulFixture, WORLD } from "../../src/gateway/sim/soul-fixture";
import { setBackendForTest, resetBackend } from "../../src/knowledge/backend";
import { resetAgentId, setAgentId } from "../../src/knowledge/agent-identity";
import { __setProactiveSoulSource } from "../../src/soul/proactive";
import { loadSoul } from "../../src/soul/loader";
import { fakeBrain } from "../memory/fake-brain";
import * as Commitments from "../../src/db/commitments";
import { runDueCommitments } from "../../src/proactive/promises";
import { NO_PREFS } from "../../src/proactive/prefs";

const AGENT_ID = "U_SLAUDE";
const MODEL = "test-model";
const POSTED = Date.parse("2026-10-27T09:00:00Z");

const ENV = ["SLAUDE_BRAIN_MODE", "SLAUDE_BRAIN_DISABLED", "SLAUDE_PRICE_TABLE", "SLAUDE_MODEL"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

beforeAll(() => {
  process.env.SLAUDE_BRAIN_MODE = "remote";
  delete process.env.SLAUDE_BRAIN_DISABLED;
  process.env.SLAUDE_PRICE_TABLE = JSON.stringify({ [MODEL]: { input: 1, output: 10, cache_read: 0.1, cache_write: 1.25 } });
  process.env.SLAUDE_MODEL = MODEL;
  setAgentId(AGENT_ID);
});
afterAll(() => {
  resetBackend();
  resetAgentId();
  __setProactiveSoulSource(null);
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

let spies: Array<ReturnType<typeof spyOn>> = [];
beforeEach(async () => {
  for (const table of ["sessions", "proactive_posts", "background_runs", "background_slots"]) await db.run(`DELETE FROM ${table}`);
  await OneOnOne._wipeForTests();
  spies = (["log", "warn", "debug"] as const).map((k) => spyOn(console, k).mockImplementation(() => {}));
});
afterEach(() => {
  for (const s of spies) s.mockRestore();
  spies = [];
});

describe("the mono gateway's proactive transport", () => {
  let h: GatewayHandle | null = null;
  let agent: AgentManager;
  let sent: Array<{ sid: string; text: string; sender?: InputSender; run?: BackgroundTurnRun }>;

  function slackTransport() {
    const client: any = {
      auth: { test: async () => ({ user_id: AGENT_ID, bot_id: "B_SLAUDE", team: "T", url: "x" }) },
      chat: { postMessage: async (m: { channel: string }) => ({ ok: true, ts: "1.1", channel: m.channel }), update: async () => ({ ok: true }) },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      assistant: { threads: { setStatus: async () => ({ ok: true }) } },
      conversations: { info: async () => ({}), members: async () => ({ members: [] }), replies: async () => ({ messages: [] }) },
      users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
      search: { messages: async () => ({}) },
    };
    return { client, action: () => {}, use: () => {}, start: async () => {}, stop: async () => {}, event: () => {} } as any;
  }

  beforeEach(() => {
    const fb = fakeBrain();
    setBackendForTest({ ready: () => true, call: (n: string, p: Record<string, unknown>, s: any) => fb.call(n, p, s), adminCall: async () => null } as any);
    writeSoulFixture(WORLD);
    __setProactiveSoulSource(() => loadSoul());
    sent = [];
    agent = new AgentManager();
    agent.sendMessage = async (sid: string, text: string, opts?: { sender?: InputSender; backgroundRun?: BackgroundTurnRun }) => {
      sent.push({ sid, text, ...(opts?.sender ? { sender: opts.sender } : {}), ...(opts?.backgroundRun ? { run: opts.backgroundRun } : {}) });
    };
  });
  afterEach(async () => {
    await h?.stop();
    h = null;
  });

  test("a wake: a turn in its channel's session folder, on the channel key, its caps reaching the turn", async () => {
    let wake: unknown;
    agent.sendMessage = async (sid: string, text: string, opts?: { backgroundRun?: BackgroundTurnRun; wake?: unknown }) => {
      wake = opts?.wake;
      sent.push({ sid, text, ...(opts?.backgroundRun ? { run: opts.backgroundRun } : {}) });
    };
    h = createGateway(agent, slackTransport());
    await h.__wake!.dispatch(
      { teamId: "T", managerId: "U0MANAGER", channelId: "C1", threadTs: "channel:C1", personaId: "default", agentId: AGENT_ID, appId: undefined },
      '<runtime-check kind="wake">look</runtime-check>',
      { runId: "run-1", agentId: AGENT_ID },
      { maxBudgetUsd: 1, maxTurns: 40 },
    );
    const row = await Sessions.findByThread({ team_id: "T", channel_id: "C1", thread_ts: "channel:C1", persona_id: "default" });
    expect(row!.working_dir).toBe(channelWorkspaceDir(AGENT_ID, "C1"));
    await Bun.sleep(0);
    expect(sent[0]!.sid).toBe(row!.id);
    expect(wake).toEqual({ maxBudgetUsd: 1, maxTurns: 40 });
  });

  test("a channel wake: the channel session, its folder, and the root-post claims reach the dispatch", async () => {
    const metas: DispatchMeta[] = [];
    const qd = {
      dispatch: async (_s: unknown, _text: string, meta: DispatchMeta) => void metas.push(meta),
      abort: async () => {},
      pubsub: { close: async () => {} },
      turns: { close: async () => {}, hasPending: async () => false },
      registry: { close: async () => {}, liveLabels: async () => [] },
      close: async () => {},
    } as unknown as QueueDispatch;
    h = createGateway(agent, slackTransport(), { queueDispatch: qd });
    // Gateway role reads the session lock from Redis before a channel wake. The
    // queue here is a fake, so the lock is too: CI's sqlite job has no Redis.
    const redis = spyOn(RedisConn, "getRedis").mockReturnValue({ exists: async () => 0 } as never);
    try {
      await h.__wake!.dispatch(
        { teamId: "T", managerId: "U0MANAGER", channelId: "C1", threadTs: "channel:C1", personaId: "default", agentId: AGENT_ID, appId: undefined },
        '<runtime-check kind="wake">look</runtime-check>',
        { runId: "run-c", agentId: AGENT_ID },
        { maxBudgetUsd: 1 },
      );
      expect(redis).toHaveBeenCalled();
    } finally {
      redis.mockRestore();
    }
    const row = await Sessions.findByThread({ team_id: "T", channel_id: "C1", thread_ts: "channel:C1", persona_id: "default" });
    expect(row!.working_dir).toBe(channelWorkspaceDir(AGENT_ID, "C1"));
    expect(metas[0]).toMatchObject({ channelId: "C1", threadTs: "channel:C1", userId: AGENT_ID, postTarget: "channel", channelSession: true, wake: { maxBudgetUsd: 1 }, backgroundRunId: "run-c", origin: "cron" });
  });

  test("a job token for a channel wake carries the channel session onto the tool plane", () => {
    h = createGateway(agent, slackTransport());
    const ctx = h.__v1SlackCtx!({ tenant: "t", persona: "default", session: "s", team: "T", channel: "C1", thread: "channel:C1", initiator: AGENT_ID, scope: "turn", job: "j", runAs: "", lock: null, sessionConfigFp: "", wake: true, bgRun: "run-c", post: "channel" } as never);
    expect(ctx.wake?.channelSession).toBe("C1");
    expect(ctx.postTarget).toBe("channel");
    const plain = h.__v1SlackCtx!({ tenant: "t", persona: "default", session: "s", team: "T", channel: "C1", thread: "1800.1", initiator: AGENT_ID, scope: "turn", job: "j", runAs: "", lock: null, sessionConfigFp: "", wake: true, bgRun: "run-c" } as never);
    // Only a channel session's wake has the wake tools.
    expect(plain.wake).toBeUndefined();
  });

  test("mono: a promise check in a proactive-folder thread while another thread holds the folder is deferred, no turn sent", async () => {
    await db.run("DELETE FROM commitments");
    h = createGateway(agent, slackTransport());
    // The promise was made in a thread whose session works in the shared proactive folder.
    const session = await Sessions.createForThread({ thread: { team_id: "T", channel_id: "C0EXAMPLE", thread_ts: "1800.100", persona_id: "default" }, model: MODEL, working_dir: proactiveWorkspaceDir(AGENT_ID) });
    sent = [];
    // Idle itself, but another session holds the proactive folder.
    let held = true;
    const asked: string[] = [];
    agent.folderHeldByOther = async (sid: string) => (asked.push(sid), held);
    const now = POSTED + 60 * 60_000;
    await Commitments.upsertOpen({
      agentId: AGENT_ID, source: `agent-${AGENT_ID}`, slug: "commitments/invoice", personaId: "default", teamId: "T",
      channelId: "C0EXAMPLE", threadTs: "1800.100", beneficiary: "U0MANAGER", runAs: null, dueText: "after the reply",
      dueKind: "event", checkText: "", onNoChange: "silent", nextCheckAt: now - 1, expiresAt: now + 86_400_000, createdAt: POSTED,
    });
    let runs = 0;
    const deps = {
      transport: h.__promises!, timeZone: "UTC", prefs: async () => NO_PREFS,
      openRun: async () => ({ ok: true as const, runId: `run-c${++runs}`, agentId: AGENT_ID }), dropRun: async () => {},
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const n = await Promise.race([
      runDueCommitments(AGENT_ID, new Date(now), deps),
      new Promise<number>((r) => (timer = setTimeout(() => r(-1), 2000))),
    ]);
    clearTimeout(timer);
    expect(n).toBe(0);
    expect(asked).toEqual([session!.id]);
    expect(sent).toEqual([]);
    expect(runs).toBe(0);
    const row = await Commitments.get({ agentId: AGENT_ID, source: `agent-${AGENT_ID}`, slug: "commitments/invoice" });
    expect(row!.nextCheckAt).toBeGreaterThan(now);
    // Once the folder is free the check goes out.
    held = false;
    expect(await runDueCommitments(AGENT_ID, new Date(row!.nextCheckAt), deps)).toBe(1);
    expect(sent.map((x) => x.sid)).toEqual([session!.id]);
  }, 5000);

  test("a promise check's thread keeps its own folder", async () => {
    h = createGateway(agent, slackTransport());
    const row = {
      agentId: AGENT_ID, source: `agent-${AGENT_ID}`, slug: "commitments/x", personaId: "default", teamId: "T",
      channelId: "C0EXAMPLE", threadTs: "2100.1", beneficiary: "U0ALICE", runAs: null, dueText: "soon",
      dueKind: "event" as const, checkText: "", onNoChange: "silent" as const, nextCheckAt: 0, expiresAt: 0,
      status: "open" as const, checks: 0, lastCheckedAt: null, createdAt: 0,
    };
    await h.__promises!.dispatch(row, "check", { runId: "run-x", agentId: AGENT_ID });
    const s = await Sessions.findByThread({ team_id: "T", channel_id: "C0EXAMPLE", thread_ts: "2100.1", persona_id: "default" });
    expect(isProactiveWorkspace(s!.working_dir)).toBe(false);
    expect(sent.map((x) => x.sid)).toEqual([s!.id]);
  });

});
