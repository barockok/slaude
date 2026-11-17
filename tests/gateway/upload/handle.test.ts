import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { mintJobToken, verifyJobToken } from "../../../src/gateway/api/auth";
import { mintUploadHandle, verifyUploadHandle, UPLOAD_HANDLE_TTL_SEC } from "../../../src/gateway/upload/handle";

const SECRET = "handle-test-secret";
const now = 1_800_000_000_000;

const job = {
  tenant: "default", persona: "default", session: "S1",
  team: "T1", channel: "C1", thread: "1.0", initiator: "U1", scope: "turn",
};
const fields = {
  tenant: "default", persona: "default", session: "S1", team: "T1", channel: "C1", thread: "1.0",
  fileId: "F1", filename: "a.txt", size: 12,
};
const caller = { tenant: "default", persona: "default", session: "S1" };
const mint = (extra: Record<string, unknown> = {}, at = now) =>
  mintUploadHandle({ ...fields, ...extra }, { secret: SECRET, now: at });
const verify = (h: string | undefined, c = caller, at = now) => verifyUploadHandle(h, c, { secret: SECRET, now: at });

describe("upload handle", () => {
  test("round trip carries every claim", () => {
    const h = mint({ post: "channel", app: "A1" });
    const r = verify(h);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.claims).toMatchObject({ ...fields, post: "channel", app: "A1", typ: "upload" });
    expect(r.claims.exp - r.claims.iat).toBe(UPLOAD_HANDLE_TTL_SEC);
  });

  test("a handle is refused as a job token", () => {
    const h = mint();
    expect(verifyJobToken(h, { secret: SECRET, now })).toMatchObject({ ok: false });
    // Even carrying every job claim, a typ makes it a handle, never a job token.
    const sneaky = mint({ initiator: "U1", scope: "turn" });
    expect(verifyJobToken(sneaky, { secret: SECRET, now })).toEqual({ ok: false, reason: "bad_claims" });
  });

  test("a job token is refused as a handle", () => {
    const t = mintJobToken(job, { secret: SECRET, now });
    expect(verify(t)).toEqual({ ok: false, reason: "bad_claims" });
  });

  test("a payload that is signed but has no typ upload is refused", () => {
    const sign = (claims: Record<string, unknown>) => {
      const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ ...fields, iat: now / 1000, exp: now / 1000 + 60, ...claims })).toString("base64url");
      return `${head}.${payload}.${createHmac("sha256", SECRET).update(`${head}.${payload}`).digest("base64url")}`;
    };
    expect(verify(sign({ typ: "upload" })).ok).toBe(true);
    expect(verify(sign({}))).toEqual({ ok: false, reason: "bad_claims" });
    expect(verify(sign({ typ: "other" }))).toEqual({ ok: false, reason: "bad_claims" });
  });

  test("a tampered payload or signature is refused", () => {
    const [head, payload, sig] = mint().split(".") as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), channel: "C2" })).toString("base64url");
    expect(verify(`${head}.${forged}.${sig}`)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verify(`${head}.${payload}.${sig.slice(0, -2)}xx`)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verify("not-a-handle")).toEqual({ ok: false, reason: "malformed" });
    expect(verify(undefined)).toEqual({ ok: false, reason: "missing" });
  });

  test("another secret is refused", () => {
    expect(verifyUploadHandle(mint(), caller, { secret: "other", now })).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("a caller with another session, persona or tenant is refused", () => {
    for (const c of [{ ...caller, session: "S2" }, { ...caller, persona: "p2" }, { ...caller, tenant: "t2" }]) {
      expect(verify(mint(), c)).toEqual({ ok: false, reason: "wrong_session" });
    }
  });

  test("expires after its own ten minutes", () => {
    const h = mint();
    expect(verify(h, caller, now + (UPLOAD_HANDLE_TTL_SEC - 1) * 1000).ok).toBe(true);
    expect(verify(h, caller, now + UPLOAD_HANDLE_TTL_SEC * 1000)).toEqual({ ok: false, reason: "expired" });
  });

  test("an unset secret reads as unconfigured", () => {
    const prev = process.env.SLAUDE_JOB_SECRET;
    delete process.env.SLAUDE_JOB_SECRET;
    try {
      expect(verifyUploadHandle("a.b.c", caller)).toEqual({ ok: false, reason: "unconfigured" });
    } finally {
      if (prev !== undefined) process.env.SLAUDE_JOB_SECRET = prev;
    }
  });
});
