import { describe, it, expect } from "bun:test";
import { parseOAuthCallback } from "../../../src/agent/mcp-oauth/callback";

describe("parseOAuthCallback", () => {
  it("parses a full redirect URL with code + state", () => {
    expect(parseOAuthCallback("https://redirect.example/page?code=ABC123&state=XYZ")).toEqual({ code: "ABC123", state: "XYZ" });
  });

  it("parses a bare query fragment with leading ?", () => {
    expect(parseOAuthCallback("?code=ABC123&state=XYZ")).toEqual({ code: "ABC123", state: "XYZ" });
  });

  it("parses a bare query fragment without ?", () => {
    expect(parseOAuthCallback("code=ABC123&state=XYZ")).toEqual({ code: "ABC123", state: "XYZ" });
  });

  it("parses a code with no state", () => {
    expect(parseOAuthCallback("https://redirect.example/page?code=ABC123")).toEqual({ code: "ABC123", state: undefined });
  });

  it("accepts a long bare code-like token (no state)", () => {
    const code = "aB3.def-ghi_jkl-MNOpqr12345"; // >= 20 chars, code-like
    expect(parseOAuthCallback(code)).toEqual({ code });
  });

  it("ignores ordinary prose / short or word-like tokens", () => {
    expect(parseOAuthCallback("is workbench connected?")).toEqual({});
    expect(parseOAuthCallback("hello")).toEqual({});
    expect(parseOAuthCallback("acknowledged")).toEqual({});       // 12 chars — below threshold
    expect(parseOAuthCallback("understood-now")).toEqual({});     // single word but < 20
    expect(parseOAuthCallback("")).toEqual({});
  });

  it("trims surrounding whitespace", () => {
    expect(parseOAuthCallback("  https://r/p?code=Q&state=S  ")).toEqual({ code: "Q", state: "S" });
  });
});
