import { afterEach, describe, expect, test } from "bun:test";
import { env } from "../../src/config/env";

const NAMES = ["SLAUDE_BOUNDARY_WRITE", "SLAUDE_BOUNDARY_TIMEOUT_MS", "SLAUDE_BOUNDARY_FILL_INTERVAL_MS", "SLAUDE_BOUNDARY_FILL_MAX_ROWS"];
afterEach(() => {
  for (const n of NAMES) delete process.env[n];
});

describe("boundary env", () => {
  test("defaults", () => {
    expect(env.boundary.write()).toBe(true);
    expect(env.boundary.timeoutMs()).toBe(300);
    expect(env.boundary.fillIntervalMs()).toBe(600_000);
    expect(env.boundary.fillMaxRows()).toBe(2000);
  });

  test("write: off values disable, anything else stays on", () => {
    for (const v of ["off", "0", "false", "no", " OFF "]) {
      process.env.SLAUDE_BOUNDARY_WRITE = v;
      expect(env.boundary.write()).toBe(false);
    }
    for (const v of ["on", "1", "yes", "", "garbage"]) {
      process.env.SLAUDE_BOUNDARY_WRITE = v;
      expect(env.boundary.write()).toBe(true);
    }
  });

  test("timeout and fill numbers: valid values read, invalid fall back", () => {
    process.env.SLAUDE_BOUNDARY_TIMEOUT_MS = "50";
    process.env.SLAUDE_BOUNDARY_FILL_INTERVAL_MS = "0";
    process.env.SLAUDE_BOUNDARY_FILL_MAX_ROWS = "10";
    expect(env.boundary.timeoutMs()).toBe(50);
    expect(env.boundary.fillIntervalMs()).toBe(0);
    expect(env.boundary.fillMaxRows()).toBe(10);
    process.env.SLAUDE_BOUNDARY_TIMEOUT_MS = "-1";
    process.env.SLAUDE_BOUNDARY_FILL_INTERVAL_MS = "abc";
    process.env.SLAUDE_BOUNDARY_FILL_MAX_ROWS = "0";
    expect(env.boundary.timeoutMs()).toBe(300);
    expect(env.boundary.fillIntervalMs()).toBe(600_000);
    expect(env.boundary.fillMaxRows()).toBe(2000);
  });
});
