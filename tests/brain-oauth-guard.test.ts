import { describe, expect, test } from "bun:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { guardConfigError, protectedResourceMetadata, verifyBearer } from "../src/knowledge/server/oauth-guard";

const ISSUER = "https://kc.example/realms/slaude";
const AUDIENCE = "slaude-brain";
const PUBLIC_URL = "https://brain.example";

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  const getJWKS = () => async () => ({ ...jwk, alg: "RS256" }) as any;
  const sign = (claims: { iss?: string; aud?: string; expSec?: number }) =>
    new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(claims.iss ?? ISSUER)
      .setAudience(claims.aud ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(claims.expSec ? `${claims.expSec}s` : "1h")
      .sign(privateKey);
  const cfg = {
    issuer: ISSUER,
    audience: AUDIENCE,
    publicUrl: PUBLIC_URL,
    authDisabled: false,
    getJWKS: getJWKS(),
  };
  return { sign, cfg };
}

describe("oauth-guard verifyBearer", () => {
  test("accepts a valid token", async () => {
    const { sign, cfg } = await setup();
    const tok = await sign({});
    const r = await verifyBearer(`Bearer ${tok}`, cfg);
    expect(r.ok).toBe(true);
  });

  test("rejects missing header with 401 + resource_metadata", async () => {
    const { cfg } = await setup();
    const r = await verifyBearer(null, cfg);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(401);
      expect(r.wwwAuth).toContain("resource_metadata=");
      expect(r.wwwAuth).toContain("oauth-protected-resource");
    }
  });

  test("rejects wrong audience", async () => {
    const { sign, cfg } = await setup();
    const tok = await sign({ aud: "someone-else" });
    const r = await verifyBearer(`Bearer ${tok}`, cfg);
    expect(r.ok).toBe(false);
  });

  test("rejects wrong issuer", async () => {
    const { sign, cfg } = await setup();
    const tok = await sign({ iss: "https://evil.example/realms/x" });
    const r = await verifyBearer(`Bearer ${tok}`, cfg);
    expect(r.ok).toBe(false);
  });

  test("rejects expired token", async () => {
    const { sign, cfg } = await setup();
    const tok = await sign({ expSec: -10 });
    const r = await verifyBearer(`Bearer ${tok}`, cfg);
    expect(r.ok).toBe(false);
  });

  test("authDisabled bypasses verification", async () => {
    const { cfg } = await setup();
    const r = await verifyBearer(null, { ...cfg, authDisabled: true });
    expect(r.ok).toBe(true);
  });

  test("fails closed (500) with a valid token but missing audience config", async () => {
    const { sign, cfg } = await setup();
    const tok = await sign({});
    const r = await verifyBearer(`Bearer ${tok}`, { ...cfg, audience: undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(500);
  });

  test("fails closed (500) with missing issuer config", async () => {
    const { sign, cfg } = await setup();
    const tok = await sign({});
    const r = await verifyBearer(`Bearer ${tok}`, { ...cfg, issuer: undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(500);
  });
});

describe("oauth-guard jwksFor (real remote resolver, no injected getJWKS)", () => {
  // No getJWKS → verifyBearer builds a real createRemoteJWKSet for the issuer and
  // fetches its certs. Point the issuer at a closed port so the fetch fails fast
  // (ECONNREFUSED) → jwtVerify throws → 401. Exercises the resolver-build + cache
  // path that every other test bypasses via an injected getJWKS.
  test("builds + caches a resolver and 401s when the JWKS endpoint is unreachable", async () => {
    const { sign } = await setup();
    const issuer = "http://127.0.0.1:1/realms/unreachable";
    const tok = await sign({ iss: issuer }); // well-formed JWS so jose invokes the key resolver
    const cfg = { issuer, audience: AUDIENCE, publicUrl: PUBLIC_URL, authDisabled: false };

    const r1 = await verifyBearer(`Bearer ${tok}`, cfg);
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.status).toBe(401);
      expect(r1.wwwAuth).toContain("invalid_token");
    }
    // Second call reuses the issuer-keyed cached resolver — same outcome.
    const r2 = await verifyBearer(`Bearer ${tok}`, cfg);
    expect(r2.ok).toBe(false);
  });
});

describe("guardConfigError", () => {
  test("ok when auth disabled regardless of issuer/audience", () => {
    expect(guardConfigError({ authDisabled: true })).toBeNull();
  });
  test("requires issuer + audience when auth enabled", () => {
    expect(guardConfigError({ authDisabled: false })).toMatch(/ISSUER/);
    expect(guardConfigError({ authDisabled: false, issuer: "i" })).toMatch(/AUDIENCE/);
    expect(guardConfigError({ authDisabled: false, issuer: "i", audience: "a" })).toBeNull();
  });
});

describe("protectedResourceMetadata", () => {
  test("returns RFC 9728 shape", () => {
    const prm = protectedResourceMetadata({
      issuer: ISSUER,
      audience: AUDIENCE,
      publicUrl: PUBLIC_URL,
      authDisabled: false,
    });
    expect(prm.resource).toBe(PUBLIC_URL);
    expect(prm.authorization_servers).toEqual([ISSUER]);
  });
});
