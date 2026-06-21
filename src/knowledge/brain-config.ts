// Config surface for the brain runtime mode (local in-process engine vs a
// remote OAuth-protected brain MCP process). Default is local — no env set
// means identical behavior to the historical in-process brain.

export type BrainMode = "local" | "remote";

export function brainMode(): BrainMode {
  return process.env.SLAUDE_BRAIN_MODE === "remote" ? "remote" : "local";
}

/** The remote brain MCP server URL. Throws in remote mode when unset. */
export function brainRemoteUrl(): string {
  const url = process.env.SLAUDE_BRAIN_URL?.trim();
  if (!url) {
    throw new Error("SLAUDE_BRAIN_MODE=remote requires SLAUDE_BRAIN_URL to be set");
  }
  return url;
}

export interface BrainServerConfig {
  port: number;
  host: string;
  /** Externally reachable base URL — used for PRM `resource` + redirect. */
  publicUrl?: string;
  /** Keycloak (or any OIDC) issuer — JWKS + iss check. */
  issuer?: string;
  /** Expected token audience. */
  audience?: string;
  /** Trusted-network / local-dev escape hatch: skip JWT verification. */
  authDisabled: boolean;
}

export function brainServerConfig(): BrainServerConfig {
  return {
    port: Number(process.env.SLAUDE_BRAIN_SERVER_PORT ?? 4319),
    host: process.env.SLAUDE_BRAIN_SERVER_HOST ?? "0.0.0.0",
    publicUrl: process.env.SLAUDE_BRAIN_PUBLIC_URL?.trim() || undefined,
    issuer: process.env.SLAUDE_BRAIN_OIDC_ISSUER?.trim() || undefined,
    audience: process.env.SLAUDE_BRAIN_OIDC_AUDIENCE?.trim() || undefined,
    authDisabled: process.env.SLAUDE_BRAIN_AUTH_DISABLED === "1",
  };
}

/** Non-interactive bearer token (bootstrap/testing). */
export function brainBearerEnv(): string | undefined {
  return process.env.SLAUDE_BRAIN_TOKEN?.trim() || undefined;
}
