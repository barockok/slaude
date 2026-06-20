// OAuth resource-server guard for the brain MCP process.
//
// The brain server is an OAuth protected resource (RFC 9728). It validates a
// Keycloak-issued (or any OIDC) bearer JWT against the issuer's JWKS, checking
// `iss` and `aud`. OAuth proves only "a legitimate slaude is calling" — scope and
// gating live in slaude. authDisabled is a trusted-network / local-dev escape hatch.

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface GuardConfig {
  issuer?: string;
  audience?: string;
  publicUrl?: string;
  authDisabled: boolean;
  /** Injectable key resolver (tests). Defaults to the issuer's JWKS endpoint. */
  getJWKS?: JWTVerifyGetKey;
}

export type VerifyResult = { ok: true } | { ok: false; status: number; wwwAuth?: string };

const PRM_PATH = "/.well-known/oauth-protected-resource";

function prmUrl(cfg: GuardConfig): string {
  const base = (cfg.publicUrl ?? "").replace(/\/+$/, "");
  return `${base}${PRM_PATH}`;
}

function challenge(cfg: GuardConfig, error?: string): string {
  const parts = [`Bearer resource_metadata="${prmUrl(cfg)}"`];
  if (error) parts.push(`error="${error}"`);
  return parts.join(", ");
}

// One JWKS resolver per issuer — jose caches keys internally.
const jwksCache = new Map<string, JWTVerifyGetKey>();
function jwksFor(cfg: GuardConfig): JWTVerifyGetKey {
  if (cfg.getJWKS) return cfg.getJWKS;
  if (!cfg.issuer) throw new Error("brain OAuth: issuer not configured");
  let resolver = jwksCache.get(cfg.issuer);
  if (!resolver) {
    const url = new URL(cfg.issuer.replace(/\/+$/, "") + "/protocol/openid-connect/certs");
    resolver = createRemoteJWKSet(url);
    jwksCache.set(cfg.issuer, resolver);
  }
  return resolver;
}

export async function verifyBearer(authHeader: string | null, cfg: GuardConfig): Promise<VerifyResult> {
  if (cfg.authDisabled) return { ok: true };
  const m = (authHeader ?? "").match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, status: 401, wwwAuth: challenge(cfg) };
  const token = m[1]!;
  try {
    await jwtVerify(token, jwksFor(cfg), {
      issuer: cfg.issuer,
      audience: cfg.audience,
    });
    return { ok: true };
  } catch {
    return { ok: false, status: 401, wwwAuth: challenge(cfg, "invalid_token") };
  }
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
}

export function protectedResourceMetadata(cfg: GuardConfig): ProtectedResourceMetadata {
  return {
    resource: cfg.publicUrl ?? "",
    authorization_servers: cfg.issuer ? [cfg.issuer] : [],
  };
}

export const PROTECTED_RESOURCE_PATH = PRM_PATH;
