/**
 * The job-moved marker reaches token refresh and reissue through the ROUTES,
 * not only when the handlers are called directly: createV1Api passes
 * `jobMovedTo` (and `jobLookup`) to both handlers, and createGateway builds
 * both from its queue dispatch. A held copy's token (its `job` claim names the
 * original id) is accepted for the copy's id only through that wiring.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createV1Api } from "../../../src/gateway/api";
import { __setNodeVerifier, JOB_HEADER, mintJobToken, verifyJobToken } from "../../../src/gateway/api/auth";
import { InMemoryPendingSource } from "../../../src/gateway/api/pending-source";
import { createGateway } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";

const LEGACY = "moved-wiring-legacy";
const VARS = ["SLAUDE_NODE_KEY", "SLAUDE_NODE_LEGACY_TOKEN", "SLAUDE_NODE_TOKEN", "SLAUDE_JOB_SECRET", "SLAUDE_NODE_LEGACY"];
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of VARS) saved[k] = process.env[k];
  delete process.env.SLAUDE_NODE_KEY;
  delete process.env.SLAUDE_NODE_TOKEN;
  delete process.env.SLAUDE_NODE_LEGACY;
  process.env.SLAUDE_NODE_LEGACY_TOKEN = LEGACY;
  process.env.SLAUDE_JOB_SECRET = "moved-wiring-job-secret";
  __setNodeVerifier(null);
});
afterAll(() => {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const HOLD = "hold-copy-1";
const QUEUE = "turns";
const now = () => Math.floor(Date.now() / 1000);
const tokenFor = (exp: number) =>
  mintJobToken({
    tenant: "default", persona: "default", session: "S-moved", team: "T1", channel: "C1", thread: "1.0",
    initiator: "U1", scope: "turn", job: "orig-1", runAs: "agent", exp,
  });
let refreshable = "";
let expired = "";
beforeAll(() => {
  refreshable = tokenFor(now() - 60);
  expired = tokenFor(now() - 2 * 3600);
});

/** The held copy carries the original token; the marker points orig-1 at it. */
const stub = (stored: string) => ({
  jobMovedTo: async (id: string) => (id === "orig-1" ? { queue: QUEUE, jobId: HOLD } : null),
  jobLookup: async (q: string, id: string) =>
    q === QUEUE && id === HOLD ? { data: { jobToken: stored, enqueuedAt: Date.now() }, timestamp: Date.now(), state: "waiting" } : null,
});

const req = (op: "token-refresh" | "token-reissue", tok: string) =>
  new Request(`http://gw/v1/jobs/${HOLD}/${op}`, {
    method: "POST",
    headers: { authorization: `Bearer ${LEGACY}`, [JOB_HEADER]: tok, "content-type": "application/json" },
    ...(op === "token-reissue" ? { body: JSON.stringify({ queue: QUEUE }) } : {}),
  });

async function namesHold(res: Response | null): Promise<void> {
  expect(res!.status).toBe(200);
  const v = verifyJobToken(((await res!.json()) as { jobToken: string }).jobToken);
  expect(v.ok && v.claims.job).toBe(HOLD);
}

const stubTools = {
  slackCtx: () => { throw new Error("unused"); },
  surfaceFor: () => { throw new Error("unused"); },
  surfaceOpts: () => { throw new Error("unused"); },
  connect: async () => "unused",
  brainDeps: () => undefined,
} as any;

describe("createV1Api passes the job-moved marker to refresh and reissue", () => {
  test("refresh and reissue of a held copy's token succeed through the routes", async () => {
    const v1 = createV1Api({ tools: stubTools, pendingSource: new InMemoryPendingSource(), ...stub(refreshable) });
    await namesHold(await v1.fetch(req("token-refresh", refreshable)));
    const v1b = createV1Api({ tools: stubTools, pendingSource: new InMemoryPendingSource(), ...stub(expired) });
    await namesHold(await v1b.fetch(req("token-reissue", expired)));
  });

  test("without the marker the same requests are 403", async () => {
    const { jobLookup } = stub(refreshable);
    const v1 = createV1Api({ tools: stubTools, pendingSource: new InMemoryPendingSource(), jobLookup });
    expect((await v1.fetch(req("token-refresh", refreshable)))!.status).toBe(403);
  });
});

describe("createGateway wires the marker from its queue dispatch", () => {
  test("a held copy's token refreshes and reissues through the gateway's /v1", async () => {
    writeSoulFixture(WORLD);
    const t = {
      client: { auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) } } as any,
      action: () => {}, event: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
    } as unknown as Transport;
    let stored = refreshable;
    const turns = {
      movedTo: async (id: string) => (id === "orig-1" ? { queue: QUEUE, jobId: HOLD } : null),
      peekJob: async (q: string, id: string) =>
        q === QUEUE && id === HOLD ? { data: { jobToken: stored, enqueuedAt: Date.now() }, timestamp: Date.now(), getState: async () => "waiting" } : undefined,
    };
    const queueDispatch = { turns, dispatch: async () => {}, abort: async () => {}, close: async () => {}, pubsub: null, registry: null } as any;
    const gw = createGateway(new AgentManager(), t, { queueDispatch });
    await namesHold(await gw.fetchV1(req("token-refresh", refreshable)));
    stored = expired;
    await namesHold(await gw.fetchV1(req("token-reissue", expired)));
  });
});
