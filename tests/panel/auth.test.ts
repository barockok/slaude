import { afterEach, describe, it, expect } from "bun:test";
import { authenticateOperator } from "../../src/gateway/panel/auth";
import { createPanelApi } from "../../src/gateway/panel/api";

const HDR = "x-auth-request-email";

afterEach(() => {
  delete process.env.SLAUDE_PANEL_HEADER;
  delete process.env.SLAUDE_PANEL_ALLOW;
  delete process.env.SLAUDE_PANEL_TRUST_HEADER;
});

const reqWith = (headers: Record<string, string>) =>
  new Request("http://x/panel/api/sessions", { headers });

describe("operator auth middleware", () => {
  it("accepts a vouched identity and attaches operatorId", () => {
    const r = authenticateOperator(reqWith({ [HDR]: "op@example.com" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.operatorId).toBe("op@example.com");
  });

  it("fails closed (403) when the identity header is absent", async () => {
    const r = authenticateOperator(reqWith({}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
  });

  it("honours a custom header name", () => {
    process.env.SLAUDE_PANEL_HEADER = "X-Forwarded-User";
    const miss = authenticateOperator(reqWith({ [HDR]: "op@example.com" }));
    expect(miss.ok).toBe(false);
    const hit = authenticateOperator(reqWith({ "x-forwarded-user": "op2" }));
    expect(hit.ok).toBe(true);
    if (hit.ok) expect(hit.operatorId).toBe("op2");
  });

  it("enforces the allowlist when set", () => {
    process.env.SLAUDE_PANEL_ALLOW = "alice@example.com, bob@example.com";
    const denied = authenticateOperator(reqWith({ [HDR]: "eve@example.com" }));
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.response.status).toBe(403);
    const allowed = authenticateOperator(reqWith({ [HDR]: "bob@example.com" }));
    expect(allowed.ok).toBe(true);
  });

  it("matches the allowlist case-insensitively (F6a — no lockout on case drift)", () => {
    process.env.SLAUDE_PANEL_ALLOW = "Alice@Example.com";
    const r = authenticateOperator(reqWith({ [HDR]: "alice@example.COM" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.operatorId).toBe("alice@example.COM"); // identity preserved for audit
  });
});

describe("panel boot guard (trust header)", () => {
  const stubDeps = {
    registry: null,
    pubsub: null,
    panelLock: null,
    chat: async () => {},
  };

  it("refuses to serve (500) when SLAUDE_PANEL_TRUST_HEADER is unset, even with a valid operator", async () => {
    // trust header unset
    const api = createPanelApi(stubDeps);
    const res = await api.fetch(reqWith({ [HDR]: "op@example.com" }));
    expect(res?.status).toBe(500);
  });

  it("serves (past the boot guard) once the trust header is acknowledged", async () => {
    process.env.SLAUDE_PANEL_TRUST_HEADER = "1";
    const api = createPanelApi(stubDeps);
    // Valid operator + trust header → the guard passes; enumerator runs against
    // the test DB and returns 200 with a sessions array.
    const res = await api.fetch(reqWith({ [HDR]: "op@example.com" }));
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  it("returns null for non-/panel paths (caller falls through)", async () => {
    process.env.SLAUDE_PANEL_TRUST_HEADER = "1";
    const api = createPanelApi(stubDeps);
    const res = await api.fetch(new Request("http://x/v1/sessions/abc"));
    expect(res).toBeNull();
  });
});
