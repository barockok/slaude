import { afterEach, describe, it, expect } from "bun:test";
import { assertPanelConfig, panelRedirectUri } from "../../src/gateway/panel/auth/config";

const VARS = [
  "SLAUDE_PANEL",
  "SLAUDE_PANEL_OIDC_ISSUER",
  "SLAUDE_PANEL_OIDC_CLIENT_ID",
  "SLAUDE_PANEL_OIDC_CLIENT_SECRET",
  "SLAUDE_PANEL_PUBLIC_URL",
  "SLAUDE_PANEL_SECRET",
  "SLAUDE_PANEL_SUPERADMIN",
  "SLAUDE_PANEL_OPERATORS",
  "SLAUDE_PANEL_ALLOW",
  "SLAUDE_PANEL_ROLES_FILE",
];

afterEach(() => {
  for (const v of VARS) delete process.env[v];
});

function configureValid() {
  process.env.SLAUDE_PANEL = "1";
  process.env.SLAUDE_PANEL_OIDC_ISSUER = "https://idp.example.com/realms/slaude";
  process.env.SLAUDE_PANEL_OIDC_CLIENT_ID = "slaude-panel";
  process.env.SLAUDE_PANEL_OIDC_CLIENT_SECRET = "s3cret";
  process.env.SLAUDE_PANEL_PUBLIC_URL = "https://panel.example.com/";
  process.env.SLAUDE_PANEL_SECRET = "x".repeat(32);
  process.env.SLAUDE_PANEL_SUPERADMIN = "lead@example.com";
}

describe("panel auth config", () => {
  it("accepts a fully configured panel", () => {
    configureValid();
    expect(() => assertPanelConfig()).not.toThrow();
  });

  it("is a no-op when the panel is disabled", () => {
    expect(() => assertPanelConfig()).not.toThrow();
  });

  it("refuses each missing required variable by name", () => {
    for (const missing of [
      "SLAUDE_PANEL_OIDC_ISSUER",
      "SLAUDE_PANEL_OIDC_CLIENT_ID",
      "SLAUDE_PANEL_OIDC_CLIENT_SECRET",
      "SLAUDE_PANEL_PUBLIC_URL",
      "SLAUDE_PANEL_SECRET",
    ]) {
      configureValid();
      delete process.env[missing];
      expect(() => assertPanelConfig()).toThrow(new RegExp(missing));
    }
  });

  it("requires a secret of at least 32 characters", () => {
    configureValid();
    process.env.SLAUDE_PANEL_SECRET = "short";
    expect(() => assertPanelConfig()).toThrow(/at least 32/);
  });

  it("refuses when no role list yields any entry", () => {
    configureValid();
    delete process.env.SLAUDE_PANEL_SUPERADMIN;
    expect(() => assertPanelConfig()).toThrow(/SLAUDE_PANEL_SUPERADMIN/);
  });

  it("refuses a leftover SLAUDE_PANEL_ALLOW with a migration message", () => {
    configureValid();
    process.env.SLAUDE_PANEL_ALLOW = "lead@example.com";
    expect(() => assertPanelConfig()).toThrow(/SLAUDE_PANEL_ALLOW is no longer used/);
  });

  it("derives the redirect URI without a doubled slash", () => {
    configureValid();
    expect(panelRedirectUri()).toBe("https://panel.example.com/panel/auth/callback");
  });
});
