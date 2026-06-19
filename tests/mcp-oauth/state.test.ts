import { describe, expect, test } from "bun:test";
import { signState, verifyState } from "../../src/agent/mcp-oauth/state";

const SECRET = "test-secret-key";

describe("signState / verifyState", () => {
  test("round-trips the sid", () => {
    const s = signState("sess-123", SECRET);
    expect(verifyState(s, SECRET)?.sid).toBe("sess-123");
  });

  test("same sid signed twice → distinct state (per-flow nonce) but both verify", () => {
    const a = signState("sess-123", SECRET);
    const b = signState("sess-123", SECRET);
    expect(a).not.toBe(b);
    expect(verifyState(a, SECRET)?.sid).toBe("sess-123");
    expect(verifyState(b, SECRET)?.sid).toBe("sess-123");
  });

  test("tampered sid → null (MAC fails)", () => {
    const s = signState("sess-123", SECRET);
    const [, nonce, mac] = s.split(".");
    const forged = `${Buffer.from("evil").toString("base64url")}.${nonce}.${mac}`;
    expect(verifyState(forged, SECRET)).toBeNull();
  });

  test("wrong secret → null", () => {
    const s = signState("sess-123", SECRET);
    expect(verifyState(s, "other-secret")).toBeNull();
  });

  test("malformed state → null", () => {
    expect(verifyState("not-a-state", SECRET)).toBeNull();
    expect(verifyState("a.b", SECRET)).toBeNull();
    expect(verifyState("", SECRET)).toBeNull();
  });

  test("sid with dots/unicode survives the round-trip", () => {
    const sid = "team.T1/chan.C1/ts.1700000000.123";
    expect(verifyState(signState(sid, SECRET), SECRET)?.sid).toBe(sid);
  });
});
