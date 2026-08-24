import { describe, it, expect } from "bun:test";
import {
  signSlackRequest,
  verifySlackSignature,
  MAX_SKEW_SEC,
} from "../../../src/gateway/slack/verify";

const SECRET = "test-signing-secret";
const BODY = JSON.stringify({ type: "event_callback", event: { type: "message" } });
const NOW = 1_756_000_000_000; // fixed clock
const ts = String(Math.floor(NOW / 1000));

function verify(over: Partial<Parameters<typeof verifySlackSignature>[0]> = {}) {
  return verifySlackSignature({
    signingSecret: SECRET,
    rawBody: BODY,
    timestamp: ts,
    signature: signSlackRequest(SECRET, ts, BODY),
    nowMs: NOW,
    ...over,
  });
}

describe("verifySlackSignature", () => {
  it("accepts a valid v0 signature", () => {
    expect(verify()).toEqual({ ok: true });
  });

  it("rejects a signature computed with the wrong secret", () => {
    const r = verify({ signature: signSlackRequest("other-secret", ts, BODY) });
    expect(r).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects when the body was tampered with after signing", () => {
    const r = verify({ rawBody: BODY + "x" });
    expect(r).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a stale timestamp (older than the replay window)", () => {
    const old = String(Math.floor(NOW / 1000) - MAX_SKEW_SEC - 1);
    const r = verify({ timestamp: old, signature: signSlackRequest(SECRET, old, BODY) });
    expect(r).toEqual({ ok: false, reason: "stale" });
  });

  it("rejects a replayed signature under a fresh timestamp", () => {
    // Attacker reuses an old valid signature but bumps the timestamp header:
    // the HMAC covers the timestamp, so it no longer matches.
    const old = String(Math.floor(NOW / 1000) - 10);
    const r = verify({ timestamp: ts, signature: signSlackRequest(SECRET, old, BODY) });
    expect(r).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a future-skewed timestamp", () => {
    const future = String(Math.floor(NOW / 1000) + MAX_SKEW_SEC + 5);
    const r = verify({ timestamp: future, signature: signSlackRequest(SECRET, future, BODY) });
    expect(r).toEqual({ ok: false, reason: "stale" });
  });

  it("rejects missing headers", () => {
    expect(verify({ timestamp: null })).toEqual({ ok: false, reason: "missing" });
    expect(verify({ signature: null })).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects a malformed timestamp", () => {
    expect(verify({ timestamp: "not-a-number" })).toEqual({
      ok: false,
      reason: "malformed_timestamp",
    });
  });

  it("rejects unknown signature versions and truncated signatures", () => {
    expect(verify({ signature: "v1=deadbeef" })).toEqual({ ok: false, reason: "bad_version" });
    expect(verify({ signature: "v0=" })).toEqual({ ok: false, reason: "bad_version" });
    // Same version, different-length hex — length check path.
    expect(verify({ signature: "v0=abc" })).toEqual({ ok: false, reason: "mismatch" });
  });

  it("honors a custom skew window", () => {
    const old = String(Math.floor(NOW / 1000) - 30);
    const sig = signSlackRequest(SECRET, old, BODY);
    expect(verify({ timestamp: old, signature: sig, maxSkewSec: 60 })).toEqual({ ok: true });
    expect(verify({ timestamp: old, signature: sig, maxSkewSec: 10 })).toEqual({
      ok: false,
      reason: "stale",
    });
  });
});
