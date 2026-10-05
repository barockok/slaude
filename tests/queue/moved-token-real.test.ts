/**
 * A job merged elsewhere leaves a HELD copy under a new id (the append-
 * elsewhere branch of moveTo). The copy carries the original job token, whose
 * `job` claim names the ORIGINAL id. Token refresh and reissue must accept it
 * for the copy's id when the job-moved marker says the original became that
 * copy, and re-mint the token for the copy's id; any other id stays a 403.
 * Real Redis (gated on SLAUDE_REDIS_TEST_URL).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Redis } from "ioredis";
import { cleanupPrefix, realEnabled, realRedis, sweepTag, testPrefix } from "./real";
import type { TurnJob, TurnQueues } from "../../src/queue/turns";
import type { Keys } from "../../src/queue/keys";

const prefix = testPrefix("movedtok");
const SECRET = "moved-token-test-secret";

describe.skipIf(!realEnabled)("token refresh and reissue for a held copy of a moved job", () => {
  let redis: Redis;
  let keys: Keys;
  let queues: TurnQueues;
  let crashing: TurnQueues;
  let jobs: typeof import("../../src/gateway/api/jobs");
  let auth: typeof import("../../src/gateway/api/auth");
  let holdId = "";
  let token = "";
  const savedSecret = process.env.SLAUDE_JOB_SECRET;

  beforeAll(async () => {
    process.env.SLAUDE_JOB_SECRET = SECRET;
    const { makeKeys } = await import("../../src/queue/keys");
    const { TurnQueues: TQ } = await import("../../src/queue/turns");
    jobs = await import("../../src/gateway/api/jobs");
    auth = await import("../../src/gateway/api/auth");
    redis = realRedis();
    await sweepTag(redis, "movedtok");
    keys = makeKeys(prefix);
    queues = new TQ({ connection: redis, keys });
    crashing = new TQ({ connection: redis, keys, afterTakeOriginal: async () => { throw new Error("simulated crash"); } });

    const now = Math.floor(Date.now() / 1000);
    token = auth.mintJobToken({
      tenant: "default", persona: "default", session: "s-mt", team: "T1", channel: "C1", thread: "1.0",
      initiator: "U1", scope: "turn", job: "mt-original", exp: now - 2 * 3600, // past the refresh grace
    });
    const turn = (text: string, ts: string): TurnJob => ({
      sessionId: "s-mt", tenantId: "default", personaId: "default",
      messages: [{ ts, user: "U1", text }], jobToken: token, enqueuedAt: Date.now(),
    });
    await queues.enqueueTurn(turn("indexed", "1700000000.000001"), { label: "mt" }, "mt-indexed");
    await redis.del(keys.coalesce("s-mt"));
    await queues.enqueueTurn(turn("stranded", "1700000000.000002"), { node: "mtnode" }, "mt-original");
    await redis.set(keys.coalesce("s-mt"), JSON.stringify({ queue: "turns.label.mt", jobId: "mt-indexed" }));
    const original = (await queues.queue("turns.mtnode").getJob("mt-original"))!;
    // A crash after the original was taken: its messages wait in a held copy.
    await expect(crashing.moveTo(original, "mt")).rejects.toThrow("simulated crash");
    holdId = (await queues.movedTo("mt-original"))!.jobId;
    expect(holdId).not.toBe("mt-original");
  });

  afterAll(async () => {
    if (savedSecret === undefined) delete process.env.SLAUDE_JOB_SECRET;
    else process.env.SLAUDE_JOB_SECRET = savedSecret;
    if (!realEnabled) return;
    await queues.close();
    await crashing.close();
    await cleanupPrefix(redis, prefix);
    await redis.quit().catch(() => {});
  });

  const movedTo = async (id: string) => (await queues.movedTo(id))?.jobId ?? null;
  const lookup = async (queue: string, jobId: string) => {
    const j = await queues.peekJob(queue, jobId);
    return j ? { data: j.data ?? {}, timestamp: j.timestamp, state: await j.getState() } : null;
  };
  const post = (id: string, op: string, body?: unknown) =>
    new Request(`http://gw/v1/jobs/${id}/${op}`, {
      method: "POST",
      headers: { [auth.JOB_HEADER]: token, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  test("reissue for the copy's id is accepted and the new token names the copy", async () => {
    const claims = auth.verifyJobToken(token, { graceSec: Number.MAX_SAFE_INTEGER });
    expect(claims.ok).toBe(true);
    if (!claims.ok) return;
    const res = await jobs.handleTokenReissue(post(holdId, "token-reissue", { queue: "turns.label.mt" }), holdId, claims.claims, lookup, Date.now(), movedTo);
    expect(res.status).toBe(200);
    const v = auth.verifyJobToken(((await res.json()) as { jobToken: string }).jobToken);
    expect(v.ok && v.claims.job).toBe(holdId);
  });

  test("refresh for the copy's id is accepted (within the grace) and names the copy", async () => {
    const now = Math.floor(Date.now() / 1000);
    const fresh = auth.mintJobToken({
      tenant: "default", persona: "default", session: "s-mt", team: "T1", channel: "C1", thread: "1.0",
      initiator: "U1", scope: "turn", job: "mt-original", exp: now - 60,
    });
    const req = new Request(`http://gw/v1/jobs/${holdId}/token-refresh`, { method: "POST", headers: { [auth.JOB_HEADER]: fresh } });
    const res = await jobs.handleTokenRefresh(req, holdId, Date.now(), movedTo);
    expect(res.status).toBe(200);
    const v = auth.verifyJobToken(((await res.json()) as { jobToken: string }).jobToken);
    expect(v.ok && v.claims.job).toBe(holdId);
  });

  test("an id the original was never moved to is still a 403", async () => {
    const now = Math.floor(Date.now() / 1000);
    const fresh = auth.mintJobToken({
      tenant: "default", persona: "default", session: "s-mt", team: "T1", channel: "C1", thread: "1.0",
      initiator: "U1", scope: "turn", job: "mt-original", exp: now + 60,
    });
    const req = new Request("http://gw/v1/jobs/mt-indexed/token-refresh", { method: "POST", headers: { [auth.JOB_HEADER]: fresh } });
    expect((await jobs.handleTokenRefresh(req, "mt-indexed", Date.now(), movedTo)).status).toBe(403);
    const claims = auth.verifyJobToken(token, { graceSec: Number.MAX_SAFE_INTEGER });
    if (!claims.ok) throw new Error("token");
    const res = await jobs.handleTokenReissue(post("mt-indexed", "token-reissue", { queue: "turns.label.mt" }), "mt-indexed", claims.claims, lookup, Date.now(), movedTo);
    expect(res.status).toBe(403);
  });
});
