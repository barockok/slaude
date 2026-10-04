/**
 * MCP credential epochs (review F2): a session that booted with a bridged
 * server it could not list (not yet connected) must re-list once the user
 * connects. Every connect / disconnect / link / unlink bumps a per-identity
 * counter; dispatch reads the turn's counters with ONE cheap read (no database
 * query) and signs them into the session-config fingerprint; a changed
 * fingerprint reboots the warm session on the node (the existing U5 path,
 * tests/agent/node-session-mode.test.ts), and the reboot re-lists.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { __resetMasterKeyCache } from "../../../src/db/crypto";
import { db, type SessionRow } from "../../../src/db/schema";
import * as Accounts from "../../../src/db/accounts";
import { verifyJobToken } from "../../../src/gateway/api/auth";
import type { JobClaims } from "../../../src/gateway/api/auth";
import { makeQueueDispatch } from "../../../src/gateway/core/dispatch";
import { createMcpBridge, connectText } from "../../../src/gateway/core/mcp-bridge";
import {
  __setDefaultEpochs,
  bumpMcpCredEpoch,
  localEpochs,
  redisEpochs,
  turnMcpEpoch,
  type McpCredEpochs,
} from "../../../src/gateway/core/mcp-cred-epoch";
import { persistConnectForOwner, persistDisconnect } from "../../../src/agent/mcp-oauth/persist";
import { sessionConfigFp } from "../../../src/remote/fingerprint";
import * as OneOnOne from "../../../src/db/one-on-one";
import { createRedis } from "../../../src/queue/redis";
import { TOOLS, startUpstream } from "./upstream";

const up = startUpstream();
afterAll(() => up.stop());

const TEAM = "TTESTTEAM1";
const ISS = "https://idp.example.com";
let epochs: McpCredEpochs;
let accountId = "";

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.SLAUDE_JOB_SECRET = "epoch-job-secret";
  __resetMasterKeyCache();
  await db.run("DELETE FROM mcp_credentials");
  await Accounts._wipeForTests();
  const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-e", email: "e@example.com" });
  await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: "UEPOCHA", accountId: a.id, via: "signed-link" });
  await Accounts.linkSlackIdentity({ teamId: "TOTHERTEAM", slackUserId: "UEPOCHB", accountId: a.id, via: "signed-link" });
  accountId = a.id;
  epochs = localEpochs();
  __setDefaultEpochs(epochs);
});
afterEach(() => __setDefaultEpochs(undefined));

describe("epochs", () => {
  test("missing is 0; a bump increments; an account bumps every Slack identity bound to it", async () => {
    const userA = { kind: "user" as const, team: TEAM, slackUserId: "UEPOCHA" };
    const userB = { kind: "user" as const, team: "TOTHERTEAM", slackUserId: "UEPOCHB" };
    expect(await epochs.read([userA, userB])).toEqual([0, 0]);
    await bumpMcpCredEpoch({ kind: "account", accountId });
    expect(await epochs.read([userA, userB])).toEqual([1, 1]);
  });

  test("connect and disconnect bump the owner; a disconnect that removed nothing does not", async () => {
    const agent = { kind: "agent" as const, tenant: "t1", persona: "ana" };
    const cfg = { type: "http", url: "https://mcp.example.com/mcp" };
    await persistConnectForOwner(agent, "crm", cfg, { clientId: "c", accessToken: "tok" });
    expect(await epochs.read([agent])).toEqual([1]);
    const target = { scope: "global" as const, tenant: "t1", persona: "ana", teamId: TEAM, slackUserId: "UMGR", serverName: "crm", cfg };
    expect(await persistDisconnect(target)).toEqual({ ok: true, removed: true });
    expect(await epochs.read([agent])).toEqual([2]);
    expect(await persistDisconnect(target)).toEqual({ ok: true, removed: false });
    expect(await epochs.read([agent])).toEqual([2]);
  });

  test("turnMcpEpoch: empty while nothing was bumped; the agent's and the person's counters otherwise; no database query", async () => {
    const q = spyOn(db, "query");
    const one = spyOn(db, "one");
    try {
      const turn = { tenant: "t1", persona: "ana", team: TEAM, runAsUser: "UEPOCHA" };
      expect(await turnMcpEpoch(turn, epochs)).toBe("");
      await epochs.bump([{ kind: "user", team: TEAM, slackUserId: "UEPOCHA" }]);
      expect(await turnMcpEpoch(turn, epochs)).toBe("0:1");
      expect(await turnMcpEpoch({ ...turn, runAsUser: null }, epochs)).toBe("");
      expect(q).not.toHaveBeenCalled();
      expect(one).not.toHaveBeenCalled();
    } finally {
      q.mockRestore();
      one.mockRestore();
    }
  });

  test("an empty epoch leaves the fingerprint exactly as before (an upgrade reboots nothing)", () => {
    const base = { runAs: "UEPOCHA", lock: null, remote: null };
    expect(sessionConfigFp({ ...base, mcpEpoch: "" })).toBe(sessionConfigFp(base));
    expect(sessionConfigFp({ ...base, mcpEpoch: "0:1" })).not.toBe(sessionConfigFp(base));
  });

  test.skipIf(!process.env.SLAUDE_REDIS_TEST_URL)("across replicas: a bump on one gateway is read by another (Redis)", async () => {
    const r1 = createRedis(process.env.SLAUDE_REDIS_TEST_URL!);
    const r2 = createRedis(process.env.SLAUDE_REDIS_TEST_URL!);
    const prefix = `u12-epoch-${randomBytes(4).toString("hex")}`;
    try {
      const owner = { kind: "agent" as const, tenant: "t1", persona: "ana" };
      expect(await redisEpochs(r2, prefix).read([owner])).toEqual([0]);
      await redisEpochs(r1, prefix).bump([owner]);
      expect(await redisEpochs(r2, prefix).read([owner])).toEqual([1]);
    } finally {
      const keys = await r1.keys(`${prefix}:*`);
      if (keys.length) await r1.del(...keys);
      r1.disconnect();
      r2.disconnect();
    }
  });
});

describe("dispatch signs the epoch into the fingerprint", () => {
  function harness() {
    const enqueued: any[] = [];
    const agent = { emit: () => false, resolveEffectiveIdentity: async () => "UEPOCHA" };
    const dispatch = makeQueueDispatch(agent as any, {
      epochs,
      infra: {
        turns: { enqueueTurn: async (job: any) => (enqueued.push(job), { queue: "turns", jobId: "J1", coalesced: false }), close: async () => {} } as any,
        registry: { lookup: async () => null, close: async () => {} } as any,
        pubsub: { consumeAbortFlag: async () => null, lastEventId: async () => null, appendEvent: async () => {}, readEvents: async () => [], close: async () => {} } as any,
      },
    });
    const fp = () => {
      const v = verifyJobToken(enqueued.at(-1).jobToken);
      if (!v.ok) throw new Error(v.reason);
      return v.claims.sessionConfigFp;
    };
    return { dispatch, fp };
  }
  const META = { teamId: TEAM, channelId: "C1", threadTs: "1.1", eventTs: "1.1", userId: "UEPOCHA", personaId: "ana", tenantId: "t1" };
  const SESSION = { id: "S-epoch" } as unknown as SessionRow;

  test("unchanged epoch: same fingerprint; a connect for the turn's person: a new one", async () => {
    await OneOnOne._wipeForTests();
    const h = harness();
    await h.dispatch.dispatch(SESSION, "one", META as any);
    const first = h.fp();
    await h.dispatch.dispatch(SESSION, "two", META as any);
    expect(h.fp()).toBe(first);
    await persistConnectForOwner({ kind: "account", accountId }, "crm", { type: "http", url: "https://mcp.example.com/mcp" }, { clientId: "c", accessToken: "tok" });
    await h.dispatch.dispatch(SESSION, "three", META as any);
    expect(h.fp()).not.toBe(first);
    await h.dispatch.close();
  });
});

describe("first use: a server that needed connecting at boot lists its tools after the connect", () => {
  test("boot list empty with the connect reason; connect bumps the epoch; the re-list (after the reboot) has the tools", async () => {
    const SERVERS = { crm: { type: "http", url: up.url } };
    const bridge = createMcpBridge({
      servers: () => ({ servers: structuredClone(SERVERS) as never, privateServices: ["crm"] }),
      policy: { allowLoopback: true, allowedHosts: [], internalHosts: [] },
      limits: () => ({ timeoutMs: 5000, ownerConcurrency: 4, maxRequestBytes: 1 << 20, maxResultBytes: 1 << 20 }),
    });
    const claims: JobClaims = {
      tenant: "t1", persona: "ana", session: "S-first", team: TEAM, channel: "C1", thread: "1.1",
      initiator: "UEPOCHA", scope: "turn", runAs: "user:UEPOCHA", exp: 0,
    };
    const turn = { tenant: "t1", persona: "ana", team: TEAM, runAsUser: "UEPOCHA" };
    try {
      const boot = await bridge.list(claims, "crm");
      expect(boot).toEqual({ tools: [], instructions: connectText("crm"), unavailable: true });
      const before = await turnMcpEpoch(turn, epochs);
      // The user connects (portal or /mcp connect): the stored grant.
      await persistConnectForOwner({ kind: "account", accountId }, "crm", SERVERS.crm, { clientId: "c", accessToken: "tok-user" });
      const after = await turnMcpEpoch(turn, epochs);
      expect(after).not.toBe(before);
      expect(sessionConfigFp({ runAs: "UEPOCHA", lock: null, remote: null, mcpEpoch: after })).not.toBe(
        sessionConfigFp({ runAs: "UEPOCHA", lock: null, remote: null, mcpEpoch: before }),
      );
      // The rebooted session's boot list.
      const relisted = await bridge.list(claims, "crm");
      expect(JSON.stringify(relisted.tools)).toBe(JSON.stringify(TOOLS));
    } finally {
      await bridge.close();
    }
  });
});
