import { describe, it, expect, afterEach } from "bun:test";
import { env } from "../../src/config/env";

const KEY = "SLAUDE_ENABLE_CONNECT_BROKER";
afterEach(() => { delete process.env[KEY]; });

describe("env.enableConnectBroker", () => {
  it("defaults to false when unset", () => {
    delete process.env[KEY];
    expect(env.enableConnectBroker()).toBe(false);
  });

  it("is true for 1 / true / yes (any case)", () => {
    for (const v of ["1", "true", "yes", "TRUE", "Yes"]) {
      process.env[KEY] = v;
      expect(env.enableConnectBroker()).toBe(true);
    }
  });

  it("is false for 0 / other values", () => {
    for (const v of ["0", "false", "no", "nope", ""]) {
      process.env[KEY] = v;
      expect(env.enableConnectBroker()).toBe(false);
    }
  });
});
