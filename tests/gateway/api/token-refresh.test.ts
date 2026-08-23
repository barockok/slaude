/**
 * POST /v1/jobs/:id/token-refresh: a job token minted at enqueue can be
 * exchanged at claim for a fresh full-TTL token with identical claims —
 * expiry forgiven within the grace window only, signature always enforced,
 * and only for the job named in the token's own `job` claim.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { JOB_HEADER, mintJobToken, verifyJobToken } from "../../../src/gateway/api/auth";
import { handleTokenRefresh, REFRESH_GRACE_SEC } from "../../../src/gateway/api/jobs";

const SECRET = "refresh-test-secret";

const baseClaims = {
  tenant: "default",
  persona: "default",
  session: "S-refresh",
  team: "T1",
  channel: "C1",
  thread: "1.0",
  initiator: "U1",
  scope: "turn",
  job: "job-123",
};

function req(token: string | null): Request {
  return new Request("http://gw/v1/jobs/job-123/token-refresh", {
    method: "POST",
    headers: token ? { [JOB_HEADER]: token } : {},
  });
}

beforeAll(() => {
  process.env.SLAUDE_JOB_SECRET = SECRET;
});

afterAll(() => {
  delete process.env.SLAUDE_JOB_SECRET;
});

describe("verifyJobToken graceSec", () => {
  test("expired token verifies within grace, not past it", () => {
    const now = Date.now();
    const expired = mintJobToken({ ...baseClaims, exp: Math.floor(now / 1000) - 600 }, { secret: SECRET });
    expect(verifyJobToken(expired, { secret: SECRET, now }).ok).toBe(false);
    expect(verifyJobToken(expired, { secret: SECRET, now, graceSec: 3600 }).ok).toBe(true);
    expect(verifyJobToken(expired, { secret: SECRET, now, graceSec: 60 }).ok).toBe(false);
  });
});

describe("/v1/jobs/:id/token-refresh", () => {
  test("stale (expired within grace) token exchanges for a fresh full-TTL token, same claims", async () => {
    const staleExp = Math.floor(Date.now() / 1000) - 30 * 60; // 30 min past exp, inside the 1h grace
    const stale = mintJobToken({ ...baseClaims, exp: staleExp });
    const res = await handleTokenRefresh(req(stale), "job-123");
    expect(res.status).toBe(200);
    const { jobToken } = (await res.json()) as { jobToken: string };
    const v = verifyJobToken(jobToken);
    expect(v.ok).toBe(true);
    if (v.ok) {
      const { exp, iat, ...rest } = v.claims;
      expect(rest).toEqual(baseClaims);
      // Full TTL again (15 min default) — not a copy of the stale expiry.
      expect(exp).toBeGreaterThan(Math.floor(Date.now() / 1000) + 10 * 60);
    }
  });

  test("a valid (unexpired) token also refreshes", async () => {
    const fresh = mintJobToken(baseClaims);
    const res = await handleTokenRefresh(req(fresh), "job-123");
    expect(res.status).toBe(200);
  });

  test("tampered signature refused", async () => {
    const stale = mintJobToken({ ...baseClaims, exp: Math.floor(Date.now() / 1000) - 60 });
    const res = await handleTokenRefresh(req(stale.slice(0, -2) + "xx"), "job-123");
    expect(res.status).toBe(401);
  });

  test("token minted for a different job refused", async () => {
    const other = mintJobToken({ ...baseClaims, job: "job-OTHER" });
    const res = await handleTokenRefresh(req(other), "job-123");
    expect(res.status).toBe(403);
    // And a token with no job claim at all cannot refresh anything.
    const { job: _job, ...noJob } = baseClaims;
    const unbound = mintJobToken(noJob);
    expect((await handleTokenRefresh(req(unbound), "job-123")).status).toBe(403);
  });

  test("token expired beyond the grace window refused", async () => {
    const ancient = mintJobToken({
      ...baseClaims,
      exp: Math.floor(Date.now() / 1000) - REFRESH_GRACE_SEC - 60,
    });
    const res = await handleTokenRefresh(req(ancient), "job-123");
    expect(res.status).toBe(401);
  });

  test("missing token refused", async () => {
    expect((await handleTokenRefresh(req(null), "job-123")).status).toBe(401);
  });
});
