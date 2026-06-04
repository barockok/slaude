import { describe, it, expect } from "bun:test";
import { missingCredsWarning } from "../../../src/gateway/sim/preflight";

describe("missingCredsWarning", () => {
  it("returns null when an API key is present", () => {
    expect(missingCredsWarning({ apiKey: "sk-x" })).toBeNull();
  });
  it("returns null with an OAuth or auth token", () => {
    expect(missingCredsWarning({ oauthToken: "oauth" })).toBeNull();
    expect(missingCredsWarning({ authToken: "tok" })).toBeNull();
  });
  it("warns when every credential is empty/undefined", () => {
    const w = missingCredsWarning({});
    expect(w).not.toBeNull();
    expect(w!).toContain("ANTHROPIC_API_KEY");
    expect(w!).toContain(".slaude/.env");
  });
  it("treats blank strings as missing", () => {
    expect(missingCredsWarning({ apiKey: "  ", oauthToken: "" })).not.toBeNull();
  });
});
