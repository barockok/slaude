import { describe, expect, test } from "bun:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { protectedResourceMetadata, verifyBearer } from "../src/knowledge/server/oauth-guard";

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
