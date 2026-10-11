/**
 * Boot-time configuration guard for panel auth.
 *
 * The panel is fail-closed by construction: with SLAUDE_PANEL=1, any missing
 * required setting stops the process rather than serving a half-configured
 * auth surface. Called once from server.ts before the panel is mounted.
 */
import { env } from "../../../config/env";
import { loadRoleConfig, type RoleConfig } from "./roles";

/** The redirect URI registered with the identity provider. */
export function panelRedirectUri(): string {
  return `${env.panel.publicUrl()}/panel/auth/callback`;
}

const REQUIRED: Array<[name: string, read: () => string]> = [
  ["SLAUDE_PANEL_OIDC_ISSUER", () => env.panel.oidcIssuer()],
  ["SLAUDE_PANEL_OIDC_CLIENT_ID", () => env.panel.oidcClientId()],
  ["SLAUDE_PANEL_OIDC_CLIENT_SECRET", () => env.panel.oidcClientSecret()],
  ["SLAUDE_PANEL_PUBLIC_URL", () => env.panel.publicUrl()],
  ["SLAUDE_PANEL_SECRET", () => env.panel.secret()],
];

/**
 * Validate the panel auth configuration. Throws with an operator-readable
 * message when the panel is enabled but cannot serve safely. No-op when the
 * panel is disabled.
 */
export function assertPanelConfig(): void {
  if (!env.panel.enabled()) return;

  // The header-trust surface is gone; a leftover allowlist would silently stop
  // granting the access its operator believes it grants.
  if (process.env.SLAUDE_PANEL_ALLOW) {
    throw new Error(
      "SLAUDE_PANEL_ALLOW is no longer used — the panel now authenticates via OIDC and reads roles from " +
        "SLAUDE_PANEL_ROLES_FILE (or SLAUDE_PANEL_SUPERADMIN / SLAUDE_PANEL_OPERATORS). Remove it.",
    );
  }
  for (const [name, read] of REQUIRED) {
    if (!read()) throw new Error(`${name} is required when SLAUDE_PANEL=1`);
  }
  if (env.panel.secret().length < 32) {
    throw new Error("SLAUDE_PANEL_SECRET must be at least 32 characters");
  }
  // The role source is *read* here, not merely declared: a mistyped path or a
  // malformed file must stop the process, not surface as a 500 on the first
  // request (guardRequest runs outside any try, and Bun.serve has no error
  // handler, so the throw would reach the client as a stack trace).
  let cfg: RoleConfig;
  try {
    cfg = loadRoleConfig();
  } catch (e) {
    throw new Error(`panel role config unusable: ${(e as Error).message}`);
  }
  // A panel nobody can reach is a misconfiguration, not a safe default.
  if (cfg.superadmin.length === 0 && cfg.operator.length === 0) {
    throw new Error(
      "no panel operators configured: set SLAUDE_PANEL_SUPERADMIN (and/or SLAUDE_PANEL_OPERATORS), " +
        "or point SLAUDE_PANEL_ROLES_FILE at a role list",
    );
  }
}
