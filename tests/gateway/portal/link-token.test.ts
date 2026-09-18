import { describe, expect, test } from "bun:test";
import { mintLinkToken, verifyLinkToken, LINK_TTL_SEC } from "../../../src/gateway/portal/link-token";
import { encodeJwt } from "../../../src/gateway/auth/jwt";

const SECRET = "c".repeat(32);
const NOW = 1_700_000_000_000;
const opts = { secret: SECRET, now: NOW };

describe("onboarding link token", () => {
  test("round-trips the slack identity it was minted for", () => {
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" }, opts);
    const r = verifyLinkToken(t, opts);
    expect(r.ok).toBe(true);
    expect(r.ok && r.claims.team).toBe("TTESTTEAM1");
    expect(r.ok && r.claims.slackUser).toBe("UTESTUSER1");
  });

  test("expires within the advertised window", () => {
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" }, opts);
    const justInside = { secret: SECRET, now: NOW + (LINK_TTL_SEC - 1) * 1000 };
    const justOutside = { secret: SECRET, now: NOW + (LINK_TTL_SEC + 1) * 1000 };
    expect(verifyLinkToken(t, justInside).ok).toBe(true);
    expect(verifyLinkToken(t, justOutside)).toEqual({ ok: false, reason: "expired" });
  });

  test("a different secret does not verify", () => {
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" }, opts);
    expect(verifyLinkToken(t, { secret: "d".repeat(32), now: NOW })).toEqual({ ok: false, reason: "bad_signature" });
  });

  // A token of another type must never be usable here, even though every token
  // this deployment signs shares one secret.
  test("a token of another type is rejected", () => {
    const foreign = encodeJwt(
      { typ: "at", sub: "s", email: "alice@example.com", exp: Math.floor(NOW / 1000) + 600 },
      SECRET,
    );
    expect(verifyLinkToken(foreign, opts)).toEqual({ ok: false, reason: "wrong_type" });
  });

  test("a token missing the slack identity is malformed, not accepted", () => {
    const partial = encodeJwt({ typ: "link", team: "TTESTTEAM1", exp: Math.floor(NOW / 1000) + 600 }, SECRET);
    expect(verifyLinkToken(partial, opts)).toEqual({ ok: false, reason: "malformed" });
  });

  test("two mints for the same identity differ", () => {
    const a = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" }, opts);
    const b = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" }, opts);
    expect(a).not.toBe(b);
  });
});
