/**
 * SLAUDE_JOB_TOKEN_MAX_AGE and SLAUDE_JOB_MAX_AGE are checked at boot (gateway
 * and mono): a bad value would otherwise make every token refresh and reissue
 * answer 500.
 */
import { describe, expect, test } from "bun:test";
import { jobAgeEnvViolations, parseDurationSec } from "../../src/config/env";

describe("job age env at boot", () => {
  test("unset and valid values pass", () => {
    expect(jobAgeEnvViolations({})).toEqual([]);
    expect(jobAgeEnvViolations({ SLAUDE_JOB_TOKEN_MAX_AGE: "6h", SLAUDE_JOB_MAX_AGE: "86400" })).toEqual([]);
    expect(jobAgeEnvViolations({ SLAUDE_JOB_TOKEN_MAX_AGE: " ", SLAUDE_JOB_MAX_AGE: "" })).toEqual([]);
  });

  test("a bad value is reported by name", () => {
    for (const bad of ["six hours", "0", "-5", "6x", "1.5h"]) {
      const v = jobAgeEnvViolations({ SLAUDE_JOB_TOKEN_MAX_AGE: bad });
      expect(v).toHaveLength(1);
      expect(v[0]).toContain("SLAUDE_JOB_TOKEN_MAX_AGE");
    }
    const both = jobAgeEnvViolations({ SLAUDE_JOB_TOKEN_MAX_AGE: "x", SLAUDE_JOB_MAX_AGE: "y" });
    expect(both.join("\n")).toContain("SLAUDE_JOB_MAX_AGE");
    expect(both).toHaveLength(2);
  });

  test("parseDurationSec", () => {
    expect(parseDurationSec("90d")).toBe(90 * 86400);
    expect(parseDurationSec("30m")).toBe(1800);
    expect(parseDurationSec("15")).toBe(15);
    expect(parseDurationSec("0")).toBeNull();
    expect(parseDurationSec("h")).toBeNull();
  });
});
