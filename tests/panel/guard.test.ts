import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { guardRequest } from "../../src/gateway/panel/auth/guard";
import { mintSession } from "../../src/gateway/panel/auth/session";
import { __resetRoleCache } from "../../src/gateway/panel/auth/roles";

const SECRET = "g".repeat(32);
const at = (email: string, ttlSec?: number) =>
  mintSession({ sub: "s", email }, "at", { secret: SECRET, ...(ttlSec != null ? { ttlSec } : {}) });

const reqWith = (cookie?: string, path = "/panel/api/sessions") =>
  new Request(`https://panel.example.com${path}`, cookie ? { headers: { cookie } } : undefined);

beforeEach(() => {
  process.env.SLAUDE_PANEL_SECRET = SECRET;
  process.env.SLAUDE_PANEL_SUPERADMIN = "lead@example.com";
  process.env.SLAUDE_PANEL_OPERATORS = "alice@example.com";
});

afterEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("SLAUDE_PANEL")) delete process.env[k];
  __resetRoleCache();
});

describe("guardRequest", () => {
  it("admits an operator and reports the role", () => {
    const r = guardRequest(reqWith(`panel_at=${at("alice@example.com")}`), { html: false });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.operatorId).toBe("alice@example.com");
      expect(r.role).toBe("operator");
    }
  });

  it("reports superadmin for a listed superadmin", () => {
    const r = guardRequest(reqWith(`panel_at=${at("lead@example.com")}`), { html: false });
    expect(r.ok && r.role).toBe("superadmin");
  });

  it("401s an API request with no session", async () => {
    const r = guardRequest(reqWith(), { html: false });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(401);
      expect(((await r.response.json()) as { error: string }).error).toContain("session");
    }
  });

  it("redirects an HTML request with no session, preserving returnTo", () => {
    const r = guardRequest(reqWith(undefined, "/panel/sessions/S-1"), { html: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(302);
      const loc = r.response.headers.get("location")!;
      expect(loc.startsWith("/panel/auth/login?returnTo=")).toBe(true);
      expect(decodeURIComponent(loc.split("returnTo=")[1]!)).toBe("/panel/sessions/S-1");
    }
  });

  it("401s an expired access token", () => {
    const r = guardRequest(reqWith(`panel_at=${at("alice@example.com", -60)}`), { html: false });
    expect(r.ok === false && r.response.status).toBe(401);
  });

  it("refuses a refresh token used as an access token", () => {
    const rt = mintSession({ sub: "s", email: "alice@example.com" }, "rt", { secret: SECRET });
    const r = guardRequest(reqWith(`panel_at=${rt}`), { html: false });
    expect(r.ok === false && r.response.status).toBe(401);
  });

  it("403s a valid session whose identity is no longer listed", () => {
    const token = at("alice@example.com");
    process.env.SLAUDE_PANEL_OPERATORS = "";
    __resetRoleCache();
    const r = guardRequest(reqWith(`panel_at=${token}`), { html: false });
    expect(r.ok === false && r.response.status).toBe(403);
  });

  it("reports the access token's expiry so the SSE tail can end cleanly", () => {
    const r = guardRequest(reqWith(`panel_at=${at("alice@example.com")}`), { html: false });
    expect(r.ok && r.expMs > Date.now()).toBe(true);
  });
});
