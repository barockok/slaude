import { describe, expect, test } from "bun:test";
import {
  mintPortalSession, verifyPortalSession, mintPortalFlow, verifyPortalFlow,
  PORTAL_AT_COOKIE, PORTAL_AT_PATH,
} from "../../../src/gateway/portal/session";
import { mintSession } from "../../../src/gateway/panel/auth/session";

const SECRET = "e".repeat(32);
const NOW = 1_700_000_000_000;
const o = { secret: SECRET, now: NOW };
const WHO = { sub: "sub-1", email: "alice@example.com", iss: "https://idp.example.com" };

describe("portal session tokens", () => {
  test("round-trips the identity", () => {
    const r = verifyPortalSession(mintPortalSession(WHO, "portal_at", o), "portal_at", o);
    expect(r.ok).toBe(true);
    expect(r.ok && r.claims.email).toBe("alice@example.com");
    expect(r.ok && r.claims.iss).toBe("https://idp.example.com");
  });

  test("a refresh token cannot be replayed as an access token", () => {
    const rt = mintPortalSession(WHO, "portal_rt", o);
    expect(verifyPortalSession(rt, "portal_at", o)).toEqual({ ok: false, reason: "wrong_type" });
  });

  // The panel and the portal share one signing secret, so type separation is
  // the boundary. A panel operator cookie must not authenticate a portal user,
  // and the reverse is covered in the panel guard's own tests.
  test("a panel session token is not a portal session token", () => {
    const panelAt = mintSession({ sub: "sub-1", email: "alice@example.com" }, "at", { secret: SECRET, now: NOW });
    expect(verifyPortalSession(panelAt, "portal_at", o)).toEqual({ ok: false, reason: "wrong_type" });
  });

  test("an onboarding link token is not a portal session token", () => {
    const { mintLinkToken } = require("../../../src/gateway/portal/link-token");
    const link = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" }, o);
    expect(verifyPortalSession(link, "portal_at", o)).toEqual({ ok: false, reason: "wrong_type" });
  });

  test("the flow payload round-trips", () => {
    const p = { state: "s", nonce: "n", verifier: "v", returnTo: "/portal" };
    const r = verifyPortalFlow(mintPortalFlow(p, o), o);
    expect(r.ok).toBe(true);
    expect(r.ok && r.payload).toEqual(p);
  });

  test("cookie name and path are scoped to the portal", () => {
    expect(PORTAL_AT_COOKIE).toBe("portal_at");
    expect(PORTAL_AT_PATH).toBe("/portal");
  });
});
