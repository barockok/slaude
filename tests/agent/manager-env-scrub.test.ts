import { describe, it, expect } from "bun:test";
import { scrubChildEnv } from "../../src/agent/manager";

describe("scrubChildEnv", () => {
  it("removes SLAUDE_ENCRYPTION_KEY from the env passed to the SDK child", () => {
    const out = scrubChildEnv({ FOO: "1", SLAUDE_ENCRYPTION_KEY: "secret" });
    expect(out.FOO).toBe("1");
    expect(out.SLAUDE_ENCRYPTION_KEY).toBeUndefined();
  });
});
