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

  const movedTo = (id: string) => queues.movedTo(id);
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

  test("refresh for the copy's id is accepted (within the grace) and names the copy; another token for the same job is not", async () => {
    // Its own held copy, carrying a token still within the refresh grace.
    const now = Math.floor(Date.now() / 1000);
    const mint = (exp: number) => auth.mintJobToken({
      tenant: "default", persona: "default", session: "s-mt3", team: "T1", channel: "C1", thread: "1.0",
      initiator: "U1", scope: "turn", job: "mt-original3", exp,
    });
    const fresh = mint(now - 60);
    const turn = (text: string, ts: string): TurnJob => ({
      sessionId: "s-mt3", tenantId: "default", personaId: "default",
      messages: [{ ts, user: "U1", text }], jobToken: fresh, enqueuedAt: Date.now(),
    });
    await queues.enqueueTurn(turn("indexed", "1700000002.000001"), { label: "mt3" }, "mt-indexed3");
    await redis.del(keys.coalesce("s-mt3"));
    await queues.enqueueTurn(turn("stranded", "1700000002.000002"), { node: "mtnode3" }, "mt-original3");
    await redis.set(keys.coalesce("s-mt3"), JSON.stringify({ queue: "turns.label.mt3", jobId: "mt-indexed3" }));
    await expect(crashing.moveTo((await queues.queue("turns.mtnode3").getJob("mt-original3"))!, "mt3")).rejects.toThrow("simulated crash");
    const hold3 = (await queues.movedTo("mt-original3"))!.jobId;
    const req = (tok: string) => new Request(`http://gw/v1/jobs/${hold3}/token-refresh`, { method: "POST", headers: { [auth.JOB_HEADER]: tok } });
    const res = await jobs.handleTokenRefresh(req(fresh), hold3, Date.now(), movedTo, lookup);
    expect(res.status).toBe(200);
    const v = auth.verifyJobToken(((await res.json()) as { jobToken: string }).jobToken);
    expect(v.ok && v.claims.job).toBe(hold3);
    // A different valid token naming the same original job is not the copy's token.
    expect((await jobs.handleTokenRefresh(req(mint(now + 60)), hold3, Date.now(), movedTo, lookup)).status).toBe(403);
  });

  test("a job MERGED into another pending job: its token is not the target's token, so refresh and reissue for the target are 403", async () => {
    const now = Math.floor(Date.now() / 1000);
    const mint = (job: string, exp: number) => auth.mintJobToken({
      tenant: "default", persona: "default", session: "s-mt2", team: "T1", channel: "C1", thread: "1.0",
      initiator: "U1", scope: "turn", job, exp,
    });
    const tokB = mint("mt-b", now + 600);
    const tokA = mint("mt-a", now + 60);
    const turn = (text: string, ts: string, jobToken: string): TurnJob => ({
      sessionId: "s-mt2", tenantId: "default", personaId: "default",
      messages: [{ ts, user: "U1", text }], jobToken, enqueuedAt: Date.now(),
    });
    await queues.enqueueTurn(turn("pending", "1700000001.000001", tokB), { label: "mt2" }, "mt-b");
    await redis.del(keys.coalesce("s-mt2"));
    await queues.enqueueTurn(turn("stranded", "1700000001.000002", tokA), { node: "mtnode2" }, "mt-a");
    await redis.set(keys.coalesce("s-mt2"), JSON.stringify({ queue: "turns.label.mt2", jobId: "mt-b" }));
    await queues.moveTo((await queues.queue("turns.mtnode2").getJob("mt-a"))!, "mt2");
    // Precondition: the marker points A at the pending job B.
    expect((await queues.movedTo("mt-a"))?.jobId).toBe("mt-b");
    const refresh = new Request("http://gw/v1/jobs/mt-b/token-refresh", { method: "POST", headers: { [auth.JOB_HEADER]: tokA } });
    expect((await jobs.handleTokenRefresh(refresh, "mt-b", Date.now(), movedTo, lookup)).status).toBe(403);
    const expiredA = mint("mt-a", now - 2 * 3600);
    const claims = auth.verifyJobToken(expiredA, { graceSec: Number.MAX_SAFE_INTEGER });
    if (!claims.ok) throw new Error("token");
    const reissue = new Request("http://gw/v1/jobs/mt-b/token-reissue", {
      method: "POST", headers: { [auth.JOB_HEADER]: expiredA, "content-type": "application/json" }, body: JSON.stringify({ queue: "turns.label.mt2" }),
    });
    expect((await jobs.handleTokenReissue(reissue, "mt-b", claims.claims, lookup, Date.now(), movedTo)).status).toBe(403);
  });

  test("an id the original was never moved to is still a 403", async () => {
    const now = Math.floor(Date.now() / 1000);
    const fresh = auth.mintJobToken({
      tenant: "default", persona: "default", session: "s-mt", team: "T1", channel: "C1", thread: "1.0",
      initiator: "U1", scope: "turn", job: "mt-original", exp: now + 60,
    });
    const req = new Request("http://gw/v1/jobs/mt-indexed/token-refresh", { method: "POST", headers: { [auth.JOB_HEADER]: fresh } });
    expect((await jobs.handleTokenRefresh(req, "mt-indexed", Date.now(), movedTo, lookup)).status).toBe(403);
    const claims = auth.verifyJobToken(token, { graceSec: Number.MAX_SAFE_INTEGER });
    if (!claims.ok) throw new Error("token");
    const res = await jobs.handleTokenReissue(post("mt-indexed", "token-reissue", { queue: "turns.label.mt" }), "mt-indexed", claims.claims, lookup, Date.now(), movedTo);
    expect(res.status).toBe(403);
  });
});
