/**
 * OIDC relying-party protocol for the panel (design §Data flow).
 *
 * Provider-agnostic: Google and Keycloak differ only in the issuer URL, and
 * every endpoint is read from the issuer's discovery document.
 *
 * The ID token's signature is deliberately NOT verified. It is only ever
 * received as the direct response to the server-to-server code exchange over
 * TLS with the client secret, which OIDC Core §3.1.3.7 permits treating as
 * verified. This holds ONLY while the panel never accepts a provider token
 * from a client — if a route ever takes a bearer ID token, JWKS verification
 * becomes mandatory (see src/knowledge/server/oauth-guard.ts for that pattern).
 */
import { createHash, randomBytes } from "node:crypto";
import { env } from "../../../config/env";
import { panelRedirectUri } from "./config";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  userClaim: string;
}

export function oidcConfigFromEnv(): OidcConfig {
  return {
    issuer: env.panel.oidcIssuer(),
    clientId: env.panel.oidcClientId(),
    clientSecret: env.panel.oidcClientSecret(),
    redirectUri: panelRedirectUri(),
    userClaim: env.panel.userClaim(),
  };
}

export interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
}

const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const discoveryCache = new Map<string, { at: number; doc: Discovery }>();

/** Test hook: forget cached discovery documents. */
export function __resetDiscoveryCache(): void {
  discoveryCache.clear();
}

export async function discover(
  issuer: string,
  opts: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<Discovery> {
  const now = opts.now ?? Date.now();
  const hit = discoveryCache.get(issuer);
  if (hit && now - hit.at < DISCOVERY_TTL_MS) return hit.doc;

  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${issuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  const doc = (await res.json()) as Partial<Discovery>;
  if (!doc.authorization_endpoint || !doc.token_endpoint) {
    throw new Error("OIDC discovery document is missing authorization_endpoint or token_endpoint");
  }
  const clean: Discovery = {
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
  };
  discoveryCache.set(issuer, { at: now, doc: clean });
  return clean;
}

/** 32 random bytes each, base64url — the login round-trip's one-time values. */
export function newFlowSecrets(): { state: string; nonce: string; verifier: string } {
  return {
    state: randomBytes(32).toString("base64url"),
    nonce: randomBytes(32).toString("base64url"),
    verifier: randomBytes(32).toString("base64url"),
  };
}

function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function buildAuthorizeUrl(
  d: Discovery,
  cfg: OidcConfig,
  s: { state: string; nonce: string; verifier: string },
): string {
  const u = new URL(d.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", s.state);
  u.searchParams.set("nonce", s.nonce);
  u.searchParams.set("code_challenge", challengeFor(s.verifier));
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export async function exchangeCode(
  d: Discovery,
  cfg: OidcConfig,
  args: { code: string; verifier: string },
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ idToken: string }> {
  const doFetch = opts.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    code_verifier: args.verifier,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
  });
  const res = await doFetch(d.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
  });
  const parsed = (await res.json().catch(() => null)) as { id_token?: string; error?: string } | null;
  if (!res.ok) {
    // Surface the provider's error code only — never the whole body, which can
    // carry tokens on some providers.
    throw new Error(`token exchange failed: ${parsed?.error ?? res.status}`);
  }
  if (!parsed?.id_token) throw new Error("token response carried no id_token");
  return { idToken: parsed.id_token };
}

export function identityFromIdToken(
  idToken: string,
  cfg: OidcConfig,
  args: { nonce: string; now?: number },
): { ok: true; sub: string; identity: string } | { ok: false; reason: string } {
  const parts = idToken.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed id_token" };
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed id_token claims" };
  }
  if (claims.iss !== cfg.issuer) return { ok: false, reason: "iss mismatch" };
  const aud = claims.aud;
  const audOk = Array.isArray(aud) ? aud.includes(cfg.clientId) : aud === cfg.clientId;
  if (!audOk) return { ok: false, reason: "aud mismatch" };
  if (claims.nonce !== args.nonce) return { ok: false, reason: "nonce mismatch" };
  const nowSec = Math.floor((args.now ?? Date.now()) / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= nowSec) return { ok: false, reason: "exp passed" };
  const raw = claims[cfg.userClaim];
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, reason: `missing identity claim '${cfg.userClaim}'` };
  const sub = typeof claims.sub === "string" ? claims.sub : "";
  if (!sub) return { ok: false, reason: "missing sub" };
  // The roles file is keyed on this string, so the issuer must vouch for it.
  // "The issuer minted this token" says nothing about whether the issuer
  // verified the address inside it: against a realm with self-registration an
  // unverified email is an identity the attacker chose. Strictly `=== false`,
  // so an issuer that omits the claim entirely is not broken by this.
  if (cfg.userClaim === "email" && claims.email_verified === false) {
    return { ok: false, reason: "email not verified by the issuer" };
  }
  return { ok: true, sub, identity: raw.trim().toLowerCase() };
}
