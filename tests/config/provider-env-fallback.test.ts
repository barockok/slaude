import { afterEach, describe, expect, test } from "bun:test";
import { env } from "../../src/config/env";

const saved = process.env.SLAUDE_PROVIDER_ENV_FALLBACK;
afterEach(() => {
  if (saved === undefined) delete process.env.SLAUDE_PROVIDER_ENV_FALLBACK;
  else process.env.SLAUDE_PROVIDER_ENV_FALLBACK = saved;
});

describe("SLAUDE_PROVIDER_ENV_FALLBACK", () => {
  test("defaults to on (today's behaviour)", () => {
    delete process.env.SLAUDE_PROVIDER_ENV_FALLBACK;
    expect(env.providerEnvFallback()).toBe(true);
  });
  test("0 turns it off, 1 on", () => {
    process.env.SLAUDE_PROVIDER_ENV_FALLBACK = "0";
    expect(env.providerEnvFallback()).toBe(false);
    process.env.SLAUDE_PROVIDER_ENV_FALLBACK = "1";
    expect(env.providerEnvFallback()).toBe(true);
  });
  test("anything else is refused, so a typo never silently means 'fall back'", () => {
    process.env.SLAUDE_PROVIDER_ENV_FALLBACK = "false";
    expect(() => env.providerEnvFallback()).toThrow(/must be 0 or 1/);
  });
});
