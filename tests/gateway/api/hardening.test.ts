/**
 * Hardening of the weak /v1 endpoints (node labels and routing spec §4.4) and
 * the whoami handshake endpoint (§4.2), through the real router.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createV1Api } from "../../../src/gateway/api";
import { __setNodeVerifier, JOB_HEADER, mintJobToken, verifyJobToken, type JobClaims } from "../../../src/gateway/api/auth";
import { mintNodeCredential, NodeCredentialVerifier } from "../../../src/gateway/auth/node-credential";
import { InMemoryPendingSource } from "../../../src/gateway/api/pending-source";
import { handleTokenReissue, JOB_EVENT_LOG_MAX, logSafe, type QueuedJob } from "../../../src/gateway/api/jobs";

const stubTools = {} as any;
const VARS = [
  "SLAUDE_NODE_KEY", "SLAUDE_NODE_LEGACY_TOKEN", "SLAUDE_NODE_TOKEN", "SLAUDE_JOB_SECRET", "SLAUDE_NODE_LEGACY",
  "SLAUDE_NODE_ALLOW_TOKENLESS_PENDING", "SLAUDE_JOB_MAX_AGE",
];
const saved: Record<string, string | undefined> = {};
const KEY = "hardening-node-key";
const LEGACY = "hardening-legacy";

const claims = (over: Partial<JobClaims> = {}): Omit<JobClaims, "exp" | "iat"> => ({
  tenant: "default", persona: "default", session: "S-own", team: "T1", channel: "C1", thread: "1.0",
  initiator: "U1", scope: "turn", job: "J1", runAs: "agent", ...over,
});
const signed = (labels = ["default"]) => mintNodeCredential({ id: "hard-a", labels }, { key: KEY });

beforeAll(() => {
  for (const k of VARS) saved[k] = process.env[k];
  for (const k of VARS) delete process.env[k];
  process.env.SLAUDE_NODE_KEY = KEY;
  process.env.SLAUDE_NODE_LEGACY_TOKEN = LEGACY;
  process.env.SLAUDE_JOB_SECRET = "hardening-job-secret";
  __setNodeVerifier(new NodeCredentialVerifier({ revocations: async () => null }));
});
afterAll(() => {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __setNodeVerifier(null);
});

const get = (v1: ReturnType<typeof createV1Api>, path: string, bearer: string, job?: string, init: RequestInit = {}) =>
  v1.fetch(
    new Request(`http://gw${path}`, {
      ...init,
      headers: { authorization: `Bearer ${bearer}`, ...(job ? { [JOB_HEADER]: job } : {}), ...(init.headers as object) },
    }),
  ) as Promise<Response>;

describe("GET /v1/node/whoami", () => {
  test("signed: id, labels, expiresInSec; legacy: default, no expiry; bad → 401", async () => {
    const v1 = createV1Api({ tools: stubTools });
    const cred = mintNodeCredential({ id: "hard-a", labels: ["finance", "eu"], ttlSec: 3600 }, { key: KEY });
    const r = await get(v1, "/v1/node/whoami", cred);
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body).toMatchObject({ id: "hard-a", labels: ["eu", "finance"], legacy: false });
    expect(body.expiresInSec).toBeGreaterThan(3590);
    expect(body.expiresInSec).toBeLessThanOrEqual(3600);
    expect(await (await get(v1, "/v1/node/whoami", LEGACY)).json()).toEqual({
      id: "legacy", labels: ["default"], legacy: true, expiresInSec: null,
    });
    expect((await get(v1, "/v1/node/whoami", "nope")).status).toBe(401);
  });
});

describe("GET /v1/pending/:id bound to the session", () => {
  let source: InMemoryPendingSource;
  let v1: ReturnType<typeof createV1Api>;
  let rowId: string;
  beforeAll(async () => {
    source = new InMemoryPendingSource();
    v1 = createV1Api({ tools: stubTools, pendingSource: source, pending: { timeoutMs: 30, pollMs: 10 } });
    const row = await source.create("approval", "S-own", { a: 1 }, Date.now() + 60_000);
    await source.resolve(row.id, "approved", "U2");
    rowId = row.id;
  });
  afterEach(() => delete process.env.SLAUDE_NODE_ALLOW_TOKENLESS_PENDING);

  test("answers the token's own session; another session gets 404 exactly like an unknown id", async () => {
    const own = await get(v1, `/v1/pending/${rowId}`, signed(), mintJobToken(claims()));
    expect(own.status).toBe(200);
    expect(((await own.json()) as any).status).toBe("approved");
    const other = await get(v1, `/v1/pending/${rowId}`, signed(), mintJobToken(claims({ session: "S-other" })));
    const unknown = await get(v1, `/v1/pending/does-not-exist`, signed(), mintJobToken(claims({ session: "S-other" })));
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual(await unknown.json());
  });

  test("tokenless: legacy only, and only while the flag is on (default on)", async () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => warns.push(String(m));
    try {
      expect((await get(v1, `/v1/pending/${rowId}`, LEGACY)).status).toBe(200);
      expect((await get(v1, `/v1/pending/${rowId}`, signed())).status).toBe(401);
      process.env.SLAUDE_NODE_ALLOW_TOKENLESS_PENDING = "0";
      expect((await get(v1, `/v1/pending/${rowId}`, LEGACY)).status).toBe(401);
    } finally {
      console.warn = orig;
    }
    expect(warns.some((w) => w.includes("SLAUDE_NODE_ALLOW_TOKENLESS_PENDING"))).toBe(true);
  });

  test("a bad token is refused, not treated as tokenless", async () => {
    expect((await get(v1, `/v1/pending/${rowId}`, LEGACY, "garbage")).status).toBe(401);
  });
});

describe("POST /v1/jobs/:id/ack|fail", () => {
  test("requires node identity; the logged body is truncated and stripped of control characters", async () => {
    const v1 = createV1Api({ tools: stubTools });
    expect((await get(v1, "/v1/jobs/J1/ack", "nope", undefined, { method: "POST", body: "{}" })).status).toBe(401);
    const lines: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      const body = JSON.stringify({ note: "line1\nFAKE [v1-jobs] ack job=forged\r\u0007" + "x".repeat(5000) });
      const r = await get(v1, "/v1/jobs/J1/fail", signed(), undefined, { method: "POST", body });
      expect(r.status).toBe(200);
    } finally {
      console.warn = orig;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("node=hard-a");
    expect(lines[0]).not.toMatch(/[\n\r\u0007]/);
    expect(lines[0]!.length).toBeLessThan(JOB_EVENT_LOG_MAX + 200);
  });

  test("logSafe", () => {
    expect(logSafe("a\nb\u0000c d")).toBe("abcd");
    expect(logSafe("x".repeat(600))).toBe("x".repeat(JOB_EVENT_LOG_MAX) + "…(truncated)");
  });
});

describe("POST /v1/jobs/:id/token-reissue", () => {
  const NOW = Date.now();
  const ancient = () => mintJobToken({ ...claims(), label: "finance" }, { now: NOW - 3 * 3600_000 }); // far past grace
  const reissueReq = (tok: string, body: unknown = { queue: "turns" }) =>
    new Request("http://gw/v1/jobs/J1/token-reissue", {
      method: "POST",
      headers: { [JOB_HEADER]: tok, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const lookupOf = (job: QueuedJob | null, seen: string[] = []) => async (q: string, id: string) => {
    seen.push(`${q}/${id}`);
    return job;
  };
  const verified = (tok: string) => (verifyJobToken(tok, { graceSec: Number.MAX_SAFE_INTEGER }) as any).claims as JobClaims;

  test("re-mints from the queued job: same claims, fresh exp, iat0 = now", async () => {
    const tok = ancient();
    const seen: string[] = [];
    const res = await handleTokenReissue(
      reissueReq(tok, { queue: "turns.node-1" }), "J1", verified(tok),
      lookupOf({ data: { jobToken: tok, enqueuedAt: NOW - 3 * 3600_000 }, timestamp: NOW - 3 * 3600_000, state: "active" }, seen),
      NOW,
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual(["turns.node-1/J1"]);
    const v = verifyJobToken(((await res.json()) as any).jobToken, { now: NOW });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.claims.label).toBe("finance");
      expect(v.claims.session).toBe("S-own");
      expect(v.claims.iat0).toBe(Math.floor(NOW / 1000));
    }
  });

  test("refused: job not in the queue, finished, another token, past the age cap, wrong job, bad queue", async () => {
    const tok = ancient();
    const c = verified(tok);
    const live = (over: Partial<QueuedJob> = {}): QueuedJob => ({
      data: { jobToken: tok, enqueuedAt: NOW - 3600_000 }, timestamp: NOW - 3600_000, state: "waiting", ...over,
    });
    expect((await handleTokenReissue(reissueReq(tok), "J1", c, lookupOf(null), NOW)).status).toBe(404);
    expect((await handleTokenReissue(reissueReq(tok), "J1", c, undefined, NOW)).status).toBe(404);
    expect((await handleTokenReissue(reissueReq(tok), "J1", c, lookupOf(live({ state: "completed" })), NOW)).status).toBe(404);
    const other = mintJobToken({ ...claims(), label: "finance" }, { now: NOW - 3 * 3600_000 + 1000 });
    expect((await handleTokenReissue(reissueReq(tok), "J1", c, lookupOf(live({ data: { jobToken: other } })), NOW)).status).toBe(403);
    const old = live({ data: { jobToken: tok, enqueuedAt: NOW - 25 * 3600_000 }, timestamp: NOW - 25 * 3600_000 });
    expect((await handleTokenReissue(reissueReq(tok), "J1", c, lookupOf(old), NOW)).status).toBe(410);
    process.env.SLAUDE_JOB_MAX_AGE = "48h";
    try {
      expect((await handleTokenReissue(reissueReq(tok), "J1", c, lookupOf(old), NOW)).status).toBe(200);
    } finally {
      delete process.env.SLAUDE_JOB_MAX_AGE;
    }
    expect((await handleTokenReissue(reissueReq(tok), "J2", c, lookupOf(live()), NOW)).status).toBe(403);
    for (const queue of ["other", "turns.", "bull:turns", 7, "turns.a:b", "turns.a\u0007", "turns.a..b", "turns.a b", "turns." + "a".repeat(200)]) {
      expect((await handleTokenReissue(reissueReq(tok, { queue }), "J1", c, lookupOf(live()), NOW)).status).toBe(400);
    }
  });

  test("a job with no usable birth time is 410, never a token with a NaN exp", async () => {
    const tok = ancient();
    for (const job of [
      { data: { jobToken: tok }, timestamp: Number.NaN, state: "active" },
      { data: { jobToken: tok, enqueuedAt: Number.NaN }, timestamp: Number.NaN, state: "active" },
      { data: { jobToken: tok, enqueuedAt: Infinity }, timestamp: undefined as unknown as number, state: "active" },
    ] as QueuedJob[]) {
      expect((await handleTokenReissue(reissueReq(tok), "J1", verified(tok), lookupOf(job), NOW)).status).toBe(410);
    }
  });

  test("a token still inside the refresh window is refused with 409 (use token-refresh)", async () => {
    // Expired 30 minutes ago: inside REFRESH_GRACE_SEC (1h).
    const recent = mintJobToken({ ...claims(), label: "finance" }, { now: NOW - 45 * 60_000 });
    const job: QueuedJob = { data: { jobToken: recent, enqueuedAt: NOW - 45 * 60_000 }, timestamp: NOW - 45 * 60_000, state: "active" };
    const res = await handleTokenReissue(reissueReq(recent), "J1", verified(recent), lookupOf(job), NOW);
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toContain("token-refresh");
    const fresh = mintJobToken({ ...claims(), label: "finance" }, { now: NOW });
    const job2: QueuedJob = { data: { jobToken: fresh, enqueuedAt: NOW }, timestamp: NOW, state: "waiting" };
    expect((await handleTokenReissue(reissueReq(fresh), "J1", verified(fresh), lookupOf(job2), NOW)).status).toBe(409);
  });

  test("repro: reissue near the 24h cap plus refreshes never keeps a token alive past enqueue + SLAUDE_JOB_MAX_AGE", async () => {
    const T = NOW - 24 * 3600_000; // enqueued exactly 24h before NOW
    const original = mintJobToken({ ...claims(), label: "finance" }, { now: T });
    const job: QueuedJob = { data: { jobToken: original, enqueuedAt: T }, timestamp: T, state: "active" };
    const at = T + (23 * 60 + 50) * 60_000; // 23h50 after enqueue
    const res = await handleTokenReissue(reissueReq(original), "J1", verified(original), lookupOf(job), at);
    expect(res.status).toBe(200);
    let tok = ((await res.json()) as any).jobToken as string;
    const capSec = Math.floor((T + 24 * 3600_000) / 1000);
    let lastExp = (verified(tok) as JobClaims).exp;
    expect(lastExp).toBeLessThanOrEqual(capSec);
    // Refresh every 5 minutes for 36 rounds (3 hours): every token stays under the cap.
    const { handleTokenRefresh } = await import("../../../src/gateway/api/jobs");
    let refused = 0;
    for (let i = 1; i <= 36; i++) {
      const now = at + i * 5 * 60_000;
      const r = await handleTokenRefresh(
        new Request("http://gw/v1/jobs/J1/token-refresh", { method: "POST", headers: { [JOB_HEADER]: tok } }),
        "J1",
        now,
      );
      if (r.status !== 200) {
        refused++;
        continue;
      }
      tok = ((await r.json()) as any).jobToken;
      lastExp = (verified(tok) as JobClaims).exp;
      expect(lastExp).toBeLessThanOrEqual(capSec);
    }
    expect(refused).toBeGreaterThan(0);
    // And a second reissue after the cap is refused.
    expect((await handleTokenReissue(reissueReq(original), "J1", verified(original), lookupOf(job), T + 24 * 3600_000 + 1000)).status).toBe(410);
  });

  test("through the router: refused without the label, accepted with it", async () => {
    const tok = ancient();
    const v1 = createV1Api({
      tools: stubTools,
      jobLookup: lookupOf({ data: { jobToken: tok, enqueuedAt: NOW - 3 * 3600_000 }, timestamp: NOW - 3 * 3600_000, state: "active" }),
    });
    const errs = console.error;
    console.error = () => {};
    try {
      const denied = await get(v1, "/v1/jobs/J1/token-reissue", signed(["engineering"]), tok, { method: "POST", body: "{}" });
      expect(denied.status).toBe(403);
      const ok = await get(v1, "/v1/jobs/J1/token-reissue", signed(["finance"]), tok, { method: "POST", body: "{}" });
      expect(ok.status).toBe(200);
      // token-refresh refuses the same token: it is past the grace.
      expect((await get(v1, "/v1/jobs/J1/token-refresh", signed(["finance"]), tok, { method: "POST" })).status).toBe(401);
    } finally {
      console.error = errs;
    }
  });
});
