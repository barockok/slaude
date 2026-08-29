/**
 * The gate as `createPanelApi.fetch` actually applies it. `guard.test.ts`
 * covers guardRequest in isolation; this file covers the wiring — which paths
 * the guard runs on, in which mode, and which path is deliberately exempt.
 */
import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { createPanelApi } from "../../src/gateway/panel/api";
import { __resetRoleCache } from "../../src/gateway/panel/auth/roles";

const PANEL_SECRET = "t".repeat(32);

const api = createPanelApi({
  registry: null,
  pubsub: null,
  panelLock: null,
  chat: async () => {},
});

const get = (path: string) => api.fetch(new Request(`https://panel.example.com${path}`));

beforeEach(() => {
  process.env.SLAUDE_PANEL_SECRET = PANEL_SECRET;
  process.env.SLAUDE_PANEL_SUPERADMIN = "lead@example.com";
  process.env.SLAUDE_PANEL_OPERATORS = "alice@example.com";
});

afterEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("SLAUDE_PANEL")) delete process.env[k];
  __resetRoleCache();
});

describe("panel API gate", () => {
  it("redirects an unauthenticated static path to login instead of serving the app", async () => {
    const res = (await get("/panel/sessions/S-1"))!;
    expect(res.status).toBe(302);
    expect(res.headers.get("location")!.startsWith("/panel/auth/login?returnTo=")).toBe(true);
  });

  it("401s an unauthenticated API path", async () => {
    const res = (await get("/panel/api/sessions"))!;
    expect(res.status).toBe(401);
  });

  it("reaches /panel/auth/* unauthenticated — and answers, rather than redirecting into a loop", async () => {
    const res = (await get("/panel/auth/me"))!;
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
  });

  it("returns null for a path outside /panel so the caller falls through", async () => {
    expect(await get("/v1/sessions/abc")).toBeNull();
  });
});
