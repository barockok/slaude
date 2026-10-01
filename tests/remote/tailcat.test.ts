import { afterEach, describe, it, expect } from "bun:test";
import { tailcatPing } from "../../src/remote/tailcat";

afterEach(() => { delete process.env.SLAUDE_TAILCAT_BIN; });

describe("tailcatPing", () => {
  it("returns unreachable (never throws) when the binary is missing", async () => {
    expect(await tailcatPing("tcAddr1", "/nonexistent-binary")).toBe("unreachable");
  });

  it("honors SLAUDE_TAILCAT_BIN at call time", async () => {
    process.env.SLAUDE_TAILCAT_BIN = "/nonexistent-binary";
    expect(await tailcatPing("tcAddr1")).toBe("unreachable");
  });

  it("rejects a flag-looking address without spawning", async () => {
    expect(await tailcatPing("--serve")).toBe("unreachable");
  });
});
