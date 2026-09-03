import { afterEach, describe, it, expect } from "bun:test";
import {
  mintSession, verifySession, mintFlow, verifyFlow,
  setCookie, clearCookie, parseCookies,
  AT_COOKIE, RT_COOKIE, AT_PATH, RT_PATH, AT_TTL_SEC,
} from "../../src/gateway/panel/auth/session";

const SECRET = "y".repeat(32);
const OTHER = "z".repeat(32);
const who = { sub: "provider-sub-1", email: "alice@example.com" };

afterEach(() => {
  delete process.env.SLAUDE_PANEL_SECRET;
});

describe("session tokens", () => {
  it("round-trips an access token", () => {
    const t = mintSession(who, "at", { secret: SECRET });
    const r = verifySession(t, "at", { secret: SECRET });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.claims.email).toBe("alice@example.com");
      expect(r.claims.sub).toBe("provider-sub-1");
      expect(r.claims.typ).toBe("at");
      expect(r.claims.exp - r.claims.iat).toBe(AT_TTL_SEC);
    }
  });

  it("mints a jti unique per access token", () => {
    const a = verifySession(mintSession(who, "at", { secret: SECRET }), "at", { secret: SECRET });
    const b = verifySession(mintSession(who, "at", { secret: SECRET }), "at", { secret: SECRET });
    expect(a.ok && b.ok && a.claims.jti !== b.claims.jti).toBe(true);
  });

  it("refuses a refresh token presented as an access token", () => {
    const rt = mintSession(who, "rt", { secret: SECRET });
    const r = verifySession(rt, "at", { secret: SECRET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("wrong_type");
  });

  it("refuses a token signed with a different secret", () => {
    const t = mintSession(who, "at", { secret: OTHER });
    const r = verifySession(t, "at", { secret: SECRET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_signature");
  });

  it("refuses a tampered payload", () => {
    const t = mintSession(who, "at", { secret: SECRET });
    const [h, , s] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...who, typ: "at", iat: 1, exp: 9e9 })).toString("base64url");
    const r = verifySession(`${h}.${forged}.${s}`, "at", { secret: SECRET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_signature");
  });

  it("refuses an expired token", () => {
    const past = Date.now() - (AT_TTL_SEC + 60) * 1000;
    const t = mintSession(who, "at", { secret: SECRET, now: past });
    const r = verifySession(t, "at", { secret: SECRET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("expired");
  });

  it("enforces HS256 regardless of the header alg", () => {
    // An 'alg: none' header with a valid HS256 signature must still verify as
    // HS256; an unsigned token must not verify at all.
    const payload = Buffer.from(JSON.stringify({ ...who, typ: "at", iat: 1, exp: 9e9 })).toString("base64url");
    const head = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const r = verifySession(`${head}.${payload}.`, "at", { secret: SECRET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_signature");
  });

  it("reports missing and malformed distinctly", () => {
    const miss = verifySession(null, "at", { secret: SECRET });
    expect(miss.ok === false && miss.reason).toBe("missing");
    const bad = verifySession("not-a-token", "at", { secret: SECRET });
    expect(bad.ok === false && bad.reason).toBe("malformed");
  });

  it("reports unconfigured when no secret is set", () => {
    const r = verifySession("a.b.c", "at", {});
    expect(r.ok === false && r.reason).toBe("unconfigured");
  });
});

describe("flow token", () => {
  it("round-trips the login flow payload", () => {
    const p = { state: "st", nonce: "no", verifier: "ve", returnTo: "/panel/sessions/S-1" };
    const r = verifyFlow(mintFlow(p, { secret: SECRET }), { secret: SECRET });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload).toEqual(p);
  });

  it("refuses a tampered flow token", () => {
    const t = mintFlow({ state: "st", nonce: "no", verifier: "ve", returnTo: "/panel" }, { secret: SECRET });
    const r = verifyFlow(t.replace(/\.[^.]+$/, ".deadbeef"), { secret: SECRET });
    expect(r.ok).toBe(false);
  });
});

describe("cookies", () => {
  it("sets the required flags and path", () => {
    const c = setCookie(AT_COOKIE, "v", { path: AT_PATH, maxAgeSec: 900 });
    expect(c).toContain("panel_at=v");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/panel");
    expect(c).toContain("Max-Age=900");
  });

  it("scopes the refresh cookie to its own endpoint", () => {
    expect(setCookie(RT_COOKIE, "v", { path: RT_PATH, maxAgeSec: 10 })).toContain("Path=/panel/auth/refresh");
  });

  it("clears with an immediate expiry", () => {
    const c = clearCookie(AT_COOKIE, AT_PATH);
    expect(c).toContain("Max-Age=0");
    expect(c).toContain("Path=/panel");
  });

  it("parses a cookie header", () => {
    const jar = parseCookies("panel_at=abc; panel_rt=def; other=1");
    expect(jar.panel_at).toBe("abc");
    expect(jar.panel_rt).toBe("def");
  });

  it("parses an absent header as empty", () => {
    expect(parseCookies(null)).toEqual({});
  });
});
