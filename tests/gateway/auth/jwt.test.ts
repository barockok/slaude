import { describe, expect, test } from "bun:test";
import { encodeJwt, decodeJwt, timingSafeStringEqual } from "../../../src/gateway/auth/jwt";

const SECRET = "a".repeat(32);
const NOW = 1_700_000_000_000;
const future = () => ({ exp: Math.floor(NOW / 1000) + 60 });

describe("encodeJwt / decodeJwt", () => {
  test("round-trips a payload", () => {
    const t = encodeJwt({ hello: "world", ...future() }, SECRET);
    const r = decodeJwt<{ hello: string }>(t, SECRET, NOW);
    expect(r.ok).toBe(true);
    expect(r.ok && r.payload.hello).toBe("world");
  });

  test("rejects a tampered payload", () => {
    const t = encodeJwt({ hello: "world", ...future() }, SECRET);
    const [h, , s] = t.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ hello: "evil", ...future() })).toString("base64url")}.${s}`;
    expect(decodeJwt(forged, SECRET, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("rejects a different secret", () => {
    const t = encodeJwt({ ...future() }, SECRET);
    expect(decodeJwt(t, "b".repeat(32), NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("reports each rejection reason distinctly", () => {
    expect(decodeJwt("x", undefined, NOW)).toEqual({ ok: false, reason: "unconfigured" });
    expect(decodeJwt(null, SECRET, NOW)).toEqual({ ok: false, reason: "missing" });
    expect(decodeJwt("only.two", SECRET, NOW)).toEqual({ ok: false, reason: "malformed" });
    const expired = encodeJwt({ exp: Math.floor(NOW / 1000) - 1 }, SECRET);
    expect(decodeJwt(expired, SECRET, NOW)).toEqual({ ok: false, reason: "expired" });
  });

  test("an alg of none in the header is ignored, not honoured", () => {
    const head = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(future())).toString("base64url");
    expect(decodeJwt(`${head}.${body}.`, SECRET, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("timingSafeStringEqual compares unequal lengths without throwing", () => {
    expect(timingSafeStringEqual("a", "aaaaaaaa")).toBe(false);
    expect(timingSafeStringEqual("same", "same")).toBe(true);
  });
});
