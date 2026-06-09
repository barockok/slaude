import { describe, it, expect } from "bun:test";
import { assertOAuthKeyCanary } from "../../../src/agent/mcp-oauth/store";

describe("assertOAuthKeyCanary", () => {
  it("returns true when oauthKey still matches the pinned golden", () => {
    expect(assertOAuthKeyCanary()).toBe(true);
  });
});
