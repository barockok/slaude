import { describe, expect, it } from "bun:test";
import { env } from "../../src/config/env";

describe("SLAUDE_PRIVATE_NOTICES", () => {
  it("is on by default, off for an off spelling, and fails open for junk", () => {
    const old = process.env.SLAUDE_PRIVATE_NOTICES;
    try {
      delete process.env.SLAUDE_PRIVATE_NOTICES;
      expect(env.privateNotices()).toBe(true);
      process.env.SLAUDE_PRIVATE_NOTICES = "off";
      expect(env.privateNotices()).toBe(false);
      process.env.SLAUDE_PRIVATE_NOTICES = "0";
      expect(env.privateNotices()).toBe(false);
      process.env.SLAUDE_PRIVATE_NOTICES = "nonsense";
      expect(env.privateNotices()).toBe(true);
    } finally {
      if (old === undefined) delete process.env.SLAUDE_PRIVATE_NOTICES;
      else process.env.SLAUDE_PRIVATE_NOTICES = old;
    }
  });
});
