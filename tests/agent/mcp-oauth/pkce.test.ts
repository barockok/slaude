import { describe, it, expect } from "bun:test";
import { createHash } from "node:crypto";
import { generatePkce, randomState } from "../../../src/agent/mcp-oauth/pkce";

describe("pkce", () => {
  it("challenge is base64url(sha256(verifier)), no padding", () => {
    const { verifier, challenge, method } = generatePkce();
    expect(method).toBe("S256");
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
    expect(challenge).not.toContain("=");
  });

  it("verifier is 43-128 url-safe chars", () => {
    const { verifier } = generatePkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it("randomState returns distinct url-safe tokens", () => {
    expect(randomState()).not.toBe(randomState());
    expect(randomState()).toMatch(/^[A-Za-z0-9\-_]+$/);
  });
});
