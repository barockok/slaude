import { env } from "../../config/env";
import { oidcConfigFromEnv, type OidcConfig } from "../panel/auth/oidc";

/** The portal's own redirect URI. It must be registered with the identity
 *  provider ALONGSIDE the panel's — same client, two callbacks. */
export function portalRedirectUri(): string {
  return `${env.panel.publicUrl()}/portal/auth/callback`;
}

/** The panel's provider settings with the portal's callback substituted. */
export function portalOidcConfig(): OidcConfig {
  return { ...oidcConfigFromEnv(), redirectUri: portalRedirectUri() };
}

/**
 * Validate the portal configuration. The portal rides on the panel's provider
 * settings, so it cannot be enabled without them. No-op when disabled.
 */
export function assertPortalConfig(): void {
  if (!env.portal.enabled()) return;
  const required: Array<[string, () => string]> = [
    ["SLAUDE_PANEL_OIDC_ISSUER", () => env.panel.oidcIssuer()],
    ["SLAUDE_PANEL_OIDC_CLIENT_ID", () => env.panel.oidcClientId()],
    ["SLAUDE_PANEL_OIDC_CLIENT_SECRET", () => env.panel.oidcClientSecret()],
    ["SLAUDE_PANEL_PUBLIC_URL", () => env.panel.publicUrl()],
    ["SLAUDE_PANEL_SECRET", () => env.panel.secret()],
  ];
  for (const [name, read] of required) {
    if (!read()) throw new Error(`${name} is required when SLAUDE_PORTAL=1`);
  }
  if (env.panel.secret().length < 32) {
    throw new Error("SLAUDE_PANEL_SECRET must be at least 32 characters");
  }
}
