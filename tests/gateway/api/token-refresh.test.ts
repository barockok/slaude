/**
 * POST /v1/jobs/:id/token-refresh: a job token minted at enqueue can be
 * exchanged at claim for a fresh full-TTL token with identical claims —
 * expiry forgiven within the grace window only, signature always enforced,
 * and only for the job named in the token's own `job` claim.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { JOB_HEADER, mintJobToken, verifyJobToken } from "../../../src/gateway/api/auth";
import { handleTokenRefresh, handleTokenReissue, REFRESH_GRACE_SEC, type QueuedJob } from "../../../src/gateway/api/jobs";

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
      const { exp, iat, iat0, ...rest } = v.claims;
      expect(rest).toEqual(baseClaims);
      // The first issue time is carried: a token with no iat0 counts from its
      // own iat.
      const staleIat = (verifyJobToken(stale, { graceSec: REFRESH_GRACE_SEC }) as any).claims.iat;
      expect(iat0).toBe(staleIat);
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

  test("refused past SLAUDE_JOB_TOKEN_MAX_AGE from the first issue; iat0 survives repeated refreshes", async () => {
    const now = Date.now();
    // A recent token whose job was first issued 5 hours ago.
    const carried = mintJobToken({ ...baseClaims, iat0: Math.floor((now - 5 * 3600_000) / 1000) }, { now: now - 60_000 });
    const r1 = await handleTokenRefresh(req(carried), "job-123", now);
    expect(r1.status).toBe(200);
    const t1 = ((await r1.json()) as { jobToken: string }).jobToken;
    const v1 = verifyJobToken(t1, { now });
    expect(v1.ok && v1.claims.iat0).toBe(Math.floor((now - 5 * 3600_000) / 1000));
    // An hour and a bit later the 6h cap is passed: refused, though the token
    // itself is still inside the grace.
    const later = now + 61 * 60_000;
    const r2 = await handleTokenRefresh(req(t1), "job-123", later);
    expect(r2.status).toBe(401);
    expect(((await r2.json()) as { error: string }).error).toContain("maximum age");
    // The cap is configurable.
    process.env.SLAUDE_JOB_TOKEN_MAX_AGE = "12h";
    try {
      expect((await handleTokenRefresh(req(t1), "job-123", later)).status).toBe(200);
    } finally {
      delete process.env.SLAUDE_JOB_TOKEN_MAX_AGE;
    }
  });

  test("missing token refused", async () => {
    expect((await handleTokenRefresh(req(null), "job-123")).status).toBe(401);
  });
});

describe("live label re-check at refresh (node labels spec §4.3, §4.8)", () => {
  /** A managed registry snapshot whose default persona runs on `label`. */
  const managedDefault = (label: string | null) => ({
    lookupByUserId: () => null,
    lookupByName: () => null,
    list: () => [],
    isMultiPersonaMode: () => false,
    isManaged: () => true,
    tombstonedPersonaFor: () => null,
    defaultPersona: () => ({ model: null, mcp: null, runsOn: label }),
  });

  test("refresh is refused with a typed 409 once the persona runs on another label", async () => {
    const { setPersonaRegistry, __resetPersonaRegistry } = await import("../../../src/persona/registry");
    const { LABEL_MISMATCH_CODE } = await import("../../../src/gateway/api/auth");
    try {
      setPersonaRegistry(managedDefault("finance") as any);
      const onEng = mintJobToken({ ...baseClaims, label: "engineering" });
      const res = await handleTokenRefresh(req(onEng), "job-123");
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "the agent's node label changed", code: LABEL_MISMATCH_CODE });
      // The token's label is still the persona's: refreshed as before.
      const onFin = mintJobToken({ ...baseClaims, label: "finance" });
      expect((await handleTokenRefresh(req(onFin), "job-123")).status).toBe(200);
      // A token from before labels is `default`: refused while the persona is on finance.
      expect((await handleTokenRefresh(req(mintJobToken(baseClaims)), "job-123")).status).toBe(409);
    } finally {
      __resetPersonaRegistry();
    }
  });

  // Review U10b-E: reissue re-mints the token's own label claim, so without
  // the same check a long-queued job would get a fresh token for a label the
  // persona no longer runs on.
  test("reissue is refused with the same typed 409 once the persona runs on another label", async () => {
    const { setPersonaRegistry, __resetPersonaRegistry } = await import("../../../src/persona/registry");
    const { LABEL_MISMATCH_CODE } = await import("../../../src/gateway/api/auth");
    const now = Date.now();
    const reissue = (label: string) => {
      const tok = mintJobToken({ ...baseClaims, label }, { now: now - 3 * 3600_000 }); // past the refresh grace
      const claims = (verifyJobToken(tok, { graceSec: Number.MAX_SAFE_INTEGER }) as any).claims;
      const job: QueuedJob = { data: { jobToken: tok, enqueuedAt: now - 3600_000 }, timestamp: now - 3600_000, state: "waiting" };
      const r = new Request("http://gw/v1/jobs/job-123/token-reissue", {
        method: "POST",
        headers: { [JOB_HEADER]: tok, "content-type": "application/json" },
        body: JSON.stringify({ queue: `turns.label.${label}` }),
      });
      return handleTokenReissue(r, "job-123", claims, async () => job, now);
    };
    try {
      setPersonaRegistry(managedDefault("finance") as any);
      const res = await reissue("engineering");
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "the agent's node label changed", code: LABEL_MISMATCH_CODE });
      expect((await reissue("finance")).status).toBe(200);
    } finally {
      __resetPersonaRegistry();
    }
  });
});

describe("/v1/jobs/:id/token-refresh — the thread's current identity", () => {
  const OneOnOne = () => import("../../../src/db/one-on-one");
  const refresh = async (claims: Record<string, unknown>) => {
    const res = await handleTokenRefresh(req(mintJobToken({ ...baseClaims, ...claims })), "job-123");
    expect(res.status).toBe(200);
    return (await res.json()) as { jobToken: string; identity?: { runAs: string; lock: unknown; remote: boolean } };
  };

  test("an unlocked thread reports the agent, unlocked, no remote", async () => {
    const body = await refresh({ runAs: "agent", lock: null });
    expect(body.identity).toEqual({ runAs: "agent", lock: null, remote: false });
  });

  test("a lock set after dispatch shows up in the refresh, while the token keeps its claims", async () => {
    const O = await OneOnOne();
    await O.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U0LOCKED1", createdBy: "U0LOCKED1" });
    try {
      const body = await refresh({ runAs: "agent", lock: null });
      expect(body.identity).toEqual({ runAs: "user:U0LOCKED1", lock: { user: "U0LOCKED1", openScope: null }, remote: false });
      const v = verifyJobToken(body.jobToken);
      expect(v.ok && v.claims.runAs).toBe("agent");
      expect(v.ok && v.claims.lock).toBeNull();
    } finally {
      await O.unlock("C1", "1.0");
    }
  });

  test("a carried person identity stays a person after the lock is gone", async () => {
    const body = await refresh({ runAs: "user:U0CRON1", lock: null });
    expect(body.identity?.runAs).toBe("user:U0CRON1");
  });

  test("a token without a runAs claim gets no identity (the node fails closed)", async () => {
    const body = await refresh({});
    expect(body.identity).toBeUndefined();
  });
});

describe("/v1/jobs/:id/token-refresh — identity lookup failure", () => {
  test("a failing lock lookup omits the identity but still refreshes the token", async () => {
    const OneOnOne = await import("../../../src/db/one-on-one");
    const { spyOn } = await import("bun:test");
    const find = spyOn(OneOnOne, "find").mockImplementation(async () => { throw new Error("db down"); });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await handleTokenRefresh(req(mintJobToken({ ...baseClaims, runAs: "agent", lock: null })), "job-123");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { jobToken: string; identity?: unknown };
      expect(typeof body.jobToken).toBe("string");
      expect("identity" in body).toBe(false);
      expect(find).toHaveBeenCalled();
      // The node side fails closed on the missing field.
      const { voiceRefusalFromClaims } = await import("../../../src/voice/hosts");
      expect(voiceRefusalFromClaims((body.identity as any) ?? null)).toBe("VOICE_UNAVAILABLE");
    } finally {
      find.mockRestore();
      warn.mockRestore();
    }
  });
});
