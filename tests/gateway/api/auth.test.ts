import { describe, expect, test } from "bun:test";
import {
  JOB_HEADER,
  mintJobToken,
  requireBearer,
  requireJobToken,
  timingSafeStringEqual,
  verifyJobToken,
  type JobClaims,
} from "../../../src/gateway/api/auth";

const SECRET = "test-job-secret";

const baseClaims: Omit<JobClaims, "exp" | "iat"> = {
  tenant: "default",
  persona: "default",
  session: "S1",
  team: "T1",
  channel: "C1",
  thread: "1.0",
  initiator: "U1",
  scope: "turn",
};

describe("timingSafeStringEqual", () => {
  test("equal / unequal / length-mismatched", () => {
    expect(timingSafeStringEqual("abc", "abc")).toBe(true);
    expect(timingSafeStringEqual("abc", "abd")).toBe(false);
    expect(timingSafeStringEqual("abc", "abcd")).toBe(false);
    expect(timingSafeStringEqual("", "")).toBe(true);
  });
});

describe("mintJobToken / verifyJobToken", () => {
  test("round-trips claims", () => {
    const token = mintJobToken(baseClaims, { secret: SECRET });
    const r = verifyJobToken(token, { secret: SECRET });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.claims.session).toBe("S1");
      expect(r.claims.tenant).toBe("default");
      expect(r.claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    }
  });

  test("expired token is rejected", () => {
    const token = mintJobToken(baseClaims, { secret: SECRET, ttlSec: 10 });
    const r = verifyJobToken(token, { secret: SECRET, now: Date.now() + 11_000 });
    expect(r).toEqual({ ok: false, reason: "expired" });
  });

  test("tampered payload is rejected", () => {
    const token = mintJobToken(baseClaims, { secret: SECRET });
    const [h, p, s] = token.split(".") as [string, string, string];
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    payload.session = "S2"; // privilege-escalate to another session
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${s}`;
    expect(verifyJobToken(forged, { secret: SECRET })).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("wrong secret is rejected", () => {
    const token = mintJobToken(baseClaims, { secret: SECRET });
    expect(verifyJobToken(token, { secret: "other" })).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("missing / malformed tokens are rejected", () => {
    expect(verifyJobToken(null, { secret: SECRET })).toEqual({ ok: false, reason: "missing" });
    expect(verifyJobToken("", { secret: SECRET })).toEqual({ ok: false, reason: "missing" });
    expect(verifyJobToken("a.b", { secret: SECRET })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyJobToken("not a jwt at all", { secret: SECRET })).toEqual({ ok: false, reason: "malformed" });
  });

  test("missing claim fields are rejected", () => {
    const { initiator: _drop, ...partial } = baseClaims;
    const token = mintJobToken(partial as any, { secret: SECRET });
    expect(verifyJobToken(token, { secret: SECRET })).toEqual({ ok: false, reason: "bad_claims" });
  });

  test("unset secret: mint throws, verify refuses", () => {
    const prev = process.env.SLAUDE_JOB_SECRET;
    delete process.env.SLAUDE_JOB_SECRET;
    try {
      expect(() => mintJobToken(baseClaims)).toThrow(/SLAUDE_JOB_SECRET/);
      expect(verifyJobToken("x.y.z")).toEqual({ ok: false, reason: "unconfigured" });
    } finally {
      if (prev !== undefined) process.env.SLAUDE_JOB_SECRET = prev;
    }
  });
});

describe("requireBearer", () => {
  const req = (auth?: string) =>
    new Request("http://localhost/v1/pending/x", { headers: auth ? { authorization: auth } : {} });

  test("unset SLAUDE_NODE_TOKEN → 503", () => {
    delete process.env.SLAUDE_NODE_TOKEN;
    const res = requireBearer(req("Bearer anything"));
    expect(res?.status).toBe(503);
  });

  test("wrong / missing / matching token", () => {
    process.env.SLAUDE_NODE_TOKEN = "node-secret";
    try {
      expect(requireBearer(req())?.status).toBe(401);
      expect(requireBearer(req("Bearer wrong"))?.status).toBe(401);
      expect(requireBearer(req("node-secret"))?.status).toBe(401); // no Bearer prefix
      expect(requireBearer(req("Bearer node-secret"))).toBeNull();
      expect(requireBearer(req("bearer node-secret"))).toBeNull(); // case-insensitive scheme
    } finally {
      delete process.env.SLAUDE_NODE_TOKEN;
    }
  });
});

describe("requireJobToken", () => {
  test("valid header → claims; invalid → 401; unconfigured → 503", () => {
    process.env.SLAUDE_JOB_SECRET = SECRET;
    try {
      const token = mintJobToken(baseClaims);
      const good = requireJobToken(new Request("http://x/v1/sessions/S1", { headers: { [JOB_HEADER]: token } }));
      expect("claims" in good && good.claims.session).toBe("S1");
      const bad = requireJobToken(new Request("http://x/v1/sessions/S1", { headers: { [JOB_HEADER]: token + "x" } }));
      expect("response" in bad && bad.response.status).toBe(401);
      const missing = requireJobToken(new Request("http://x/v1/sessions/S1"));
      expect("response" in missing && missing.response.status).toBe(401);
    } finally {
      delete process.env.SLAUDE_JOB_SECRET;
    }
    const unconfigured = requireJobToken(new Request("http://x/v1/sessions/S1"));
    expect("response" in unconfigured && unconfigured.response.status).toBe(503);
  });
});
