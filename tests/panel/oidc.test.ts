import { afterEach, describe, it, expect } from "bun:test";
import {
  discover, __resetDiscoveryCache, newFlowSecrets, buildAuthorizeUrl,
  exchangeCode, identityFromIdToken, type OidcConfig,
} from "../../src/gateway/panel/auth/oidc";

const CFG: OidcConfig = {
  issuer: "https://idp.example.com/realms/slaude",
  clientId: "slaude-panel",
  clientSecret: "s3cret",
  redirectUri: "https://panel.example.com/panel/auth/callback",
  userClaim: "email",
};
const DISCO = {
  authorization_endpoint: "https://idp.example.com/realms/slaude/protocol/openid-connect/auth",
  token_endpoint: "https://idp.example.com/realms/slaude/protocol/openid-connect/token",
};

// Unsigned ID token: the panel reads claims from the token-endpoint response
// over TLS and never verifies a signature (design §Why no JWKS verification).
function idToken(claims: Record<string, unknown>): string {
  const b = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${b({ alg: "RS256" })}.${b(claims)}.sig`;
}
const baseClaims = (over: Record<string, unknown> = {}) => ({
  iss: CFG.issuer, aud: CFG.clientId, nonce: "N1", sub: "sub-1",
  email: "Alice@Example.com", exp: Math.floor(Date.now() / 1000) + 300, ...over,
});

afterEach(() => __resetDiscoveryCache());

describe("discovery", () => {
  it("fetches and caches the discovery document", async () => {
    let calls = 0;
    const fetchImpl = (async (url: string | URL) => {
      calls++;
      expect(String(url)).toBe(`${CFG.issuer}/.well-known/openid-configuration`);
      return new Response(JSON.stringify(DISCO), { status: 200 });
    }) as unknown as typeof fetch;
    expect((await discover(CFG.issuer, { fetchImpl })).token_endpoint).toBe(DISCO.token_endpoint);
    await discover(CFG.issuer, { fetchImpl });
    expect(calls).toBe(1);
  });

  it("throws when discovery is unreachable", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(discover(CFG.issuer, { fetchImpl })).rejects.toThrow(/discovery/i);
  });

  it("throws when the document lacks the endpoints", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    await expect(discover(CFG.issuer, { fetchImpl })).rejects.toThrow(/endpoint/);
  });
});

describe("authorize URL", () => {
  it("carries PKCE S256, scope, state and nonce", () => {
    const s = { state: "ST", nonce: "NO", verifier: "V".repeat(43) };
    const u = new URL(buildAuthorizeUrl(DISCO, CFG, s));
    expect(u.origin + u.pathname).toBe(DISCO.authorization_endpoint);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe(CFG.clientId);
    expect(u.searchParams.get("redirect_uri")).toBe(CFG.redirectUri);
    expect(u.searchParams.get("scope")).toBe("openid email profile");
    expect(u.searchParams.get("state")).toBe("ST");
    expect(u.searchParams.get("nonce")).toBe("NO");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    const ch = u.searchParams.get("code_challenge")!;
    expect(ch).not.toBe(s.verifier);
    expect(ch).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("generates distinct high-entropy secrets", () => {
    const a = newFlowSecrets();
    const b = newFlowSecrets();
    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.verifier.length).toBeGreaterThanOrEqual(43);
  });
});

describe("code exchange", () => {
  it("posts the code and verifier, returning the id_token", async () => {
    let body = "";
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe(DISCO.token_endpoint);
      expect(init?.method).toBe("POST");
      body = String(init?.body);
      return new Response(JSON.stringify({ id_token: "ID", access_token: "AT" }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await exchangeCode(DISCO, CFG, { code: "C", verifier: "V" }, { fetchImpl });
    expect(r.idToken).toBe("ID");
    const p = new URLSearchParams(body);
    expect(p.get("grant_type")).toBe("authorization_code");
    expect(p.get("code")).toBe("C");
    expect(p.get("code_verifier")).toBe("V");
    expect(p.get("client_id")).toBe(CFG.clientId);
    expect(p.get("client_secret")).toBe(CFG.clientSecret);
    expect(p.get("redirect_uri")).toBe(CFG.redirectUri);
  });

  it("throws without leaking the response body when the provider rejects", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as unknown as typeof fetch;
    await expect(exchangeCode(DISCO, CFG, { code: "C", verifier: "V" }, { fetchImpl }))
      .rejects.toThrow(/invalid_grant/);
  });

  it("throws when the response carries no id_token", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ access_token: "AT" }), { status: 200 })) as unknown as typeof fetch;
    await expect(exchangeCode(DISCO, CFG, { code: "C", verifier: "V" }, { fetchImpl })).rejects.toThrow(/id_token/);
  });
});

describe("identity extraction", () => {
  it("lowercases the identity claim and returns the subject", () => {
    const r = identityFromIdToken(idToken(baseClaims()), CFG, { nonce: "N1" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toBe("alice@example.com");
      expect(r.sub).toBe("sub-1");
    }
  });

  it("accepts an aud array containing the client id", () => {
    const r = identityFromIdToken(idToken(baseClaims({ aud: ["other", CFG.clientId] })), CFG, { nonce: "N1" });
    expect(r.ok).toBe(true);
  });

  for (const [label, claims, reason] of [
    ["a wrong issuer", baseClaims({ iss: "https://evil.example.com" }), "iss"],
    ["a wrong audience", baseClaims({ aud: "someone-else" }), "aud"],
    ["a mismatched nonce", baseClaims({ nonce: "OTHER" }), "nonce"],
    ["an expired token", baseClaims({ exp: Math.floor(Date.now() / 1000) - 10 }), "exp"],
    ["a missing identity claim", baseClaims({ email: undefined }), "claim"],
  ] as const) {
    it(`refuses ${label}`, () => {
      const r = identityFromIdToken(idToken(claims), CFG, { nonce: "N1" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain(reason);
    });
  }

  it("refuses a malformed token", () => {
    const r = identityFromIdToken("garbage", CFG, { nonce: "N1" });
    expect(r.ok).toBe(false);
  });

  // Roles are keyed on the email string, so an issuer that has not verified it
  // would let a self-registered account choose a listed identity.
  it("refuses an email the issuer marked unverified", () => {
    const r = identityFromIdToken(idToken(baseClaims({ email_verified: false })), CFG, { nonce: "N1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("email not verified by the issuer");
  });

  it("accepts a token that omits email_verified (not every issuer sends it)", () => {
    const r = identityFromIdToken(idToken(baseClaims({ email_verified: true })), CFG, { nonce: "N1" });
    expect(r.ok).toBe(true);
    expect(identityFromIdToken(idToken(baseClaims()), CFG, { nonce: "N1" }).ok).toBe(true);
  });

  it("honours a custom user claim", () => {
    const cfg = { ...CFG, userClaim: "preferred_username" };
    const r = identityFromIdToken(idToken(baseClaims({ preferred_username: "Alice" })), cfg, { nonce: "N1" });
    expect(r.ok && r.identity).toBe("alice");
  });
});
