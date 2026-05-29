import { describe, it, expect } from "bun:test";
import { mintLoginToken, verifyLoginToken } from "../../../src/agent/connect-broker/login-token";

const SECRET = Buffer.alloc(32, 3);

describe("login token", () => {
  it("verifies a freshly minted token for the bound user", () => {
    const tok = mintLoginToken(SECRET, { loginId: "L1", slackUserId: "U1", exp: 1000 });
    const v = verifyLoginToken(SECRET, tok, { now: 500 });
    expect(v).toEqual({ loginId: "L1", slackUserId: "U1", exp: 1000 });
  });

  it("rejects an expired token", () => {
    const tok = mintLoginToken(SECRET, { loginId: "L1", slackUserId: "U1", exp: 1000 });
    expect(verifyLoginToken(SECRET, tok, { now: 2000 })).toBeNull();
  });

  it("rejects a tampered token", () => {
    const tok = mintLoginToken(SECRET, { loginId: "L1", slackUserId: "U1", exp: 1000 });
    const bad = tok.slice(0, -2) + (tok.endsWith("a") ? "b" : "a");
    expect(verifyLoginToken(SECRET, bad, { now: 500 })).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const tok = mintLoginToken(SECRET, { loginId: "L1", slackUserId: "U1", exp: 1000 });
    expect(verifyLoginToken(Buffer.alloc(32, 9), tok, { now: 500 })).toBeNull();
  });
});
