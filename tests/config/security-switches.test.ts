/**
 * The security switches share one spelling rule, and an unknown value refuses
 * the boot of the role that reads it (src/config/security-switches.ts).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { parseFlag, securitySwitchViolations } from "../../src/config/security-switches";
import { env } from "../../src/config/env";

const SAVED = ["SLAUDE_NODE_LEGACY", "SLAUDE_NODE_ALLOW_TOKENLESS_PENDING"].map((k) => [k, process.env[k]] as const);
afterEach(() => {
  for (const [k, v] of SAVED) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("parseFlag", () => {
  test("accepts the same spellings everywhere, any case, surrounding space ignored", () => {
    for (const v of ["1", "true", "YES", " on "]) expect(parseFlag(v)).toBe(true);
    for (const v of ["0", "false", "No", "OFF "]) expect(parseFlag(v)).toBe(false);
    expect(parseFlag(undefined)).toBeUndefined();
    expect(parseFlag("  ")).toBeUndefined();
    for (const v of ["2", "disable", "of", "enabled"]) expect(parseFlag(v)).toBeNull();
  });
});

describe("SLAUDE_NODE_LEGACY", () => {
  test("every off spelling closes the legacy door (only 'off' used to)", () => {
    for (const v of ["off", "0", "false", "no", "OFF"]) {
      process.env.SLAUDE_NODE_LEGACY = v;
      expect(env.nodeLegacyOff()).toBe(true);
    }
    for (const v of ["on", "1", "true", ""]) {
      process.env.SLAUDE_NODE_LEGACY = v;
      expect(env.nodeLegacyOff()).toBe(false);
    }
  });
  test("an unknown value fails closed at runtime", () => {
    process.env.SLAUDE_NODE_LEGACY = "of";
    expect(env.nodeLegacyOff()).toBe(true);
  });
});

describe("SLAUDE_NODE_ALLOW_TOKENLESS_PENDING", () => {
  test("default on; an unknown value fails closed at runtime", () => {
    delete process.env.SLAUDE_NODE_ALLOW_TOKENLESS_PENDING;
    expect(env.allowTokenlessPending()).toBe(true);
    process.env.SLAUDE_NODE_ALLOW_TOKENLESS_PENDING = "nope";
    expect(env.allowTokenlessPending()).toBe(false);
  });
});

describe("securitySwitchViolations: an unknown value refuses the boot, naming the variable", () => {
  test("gateway and mono check the gateway switches", () => {
    for (const role of ["gateway", "mono"] as const) {
      expect(securitySwitchViolations(role, {})).toEqual([]);
      expect(securitySwitchViolations(role, { SLAUDE_NODE_LEGACY: "off", SLAUDE_DEPLOY_STRICT: "0", SLAUDE_NODE_ALLOW_TOKENLESS_PENDING: "no" })).toEqual([]);
      const bad = securitySwitchViolations(role, { SLAUDE_NODE_LEGACY: "closed", SLAUDE_DEPLOY_STRICT: "strict", SLAUDE_NODE_ALLOW_TOKENLESS_PENDING: "2" });
      expect(bad).toHaveLength(3);
      expect(bad.join("\n")).toContain("SLAUDE_NODE_LEGACY");
      expect(bad.join("\n")).toContain("SLAUDE_DEPLOY_STRICT");
      expect(bad.join("\n")).toContain("SLAUDE_NODE_ALLOW_TOKENLESS_PENDING");
    }
  });
  test("a node checks its boot-check mode and its escape", () => {
    expect(securitySwitchViolations("node", {})).toEqual([]);
    expect(securitySwitchViolations("node", { SLAUDE_NODE_BOOT_CHECK: "warn", SLAUDE_NODE_ALLOW_GATEWAY_SECRETS: "true" })).toEqual([]);
    const bad = securitySwitchViolations("node", { SLAUDE_NODE_BOOT_CHECK: "refuse!", SLAUDE_NODE_ALLOW_GATEWAY_SECRETS: "y" });
    expect(bad).toHaveLength(2);
    expect(bad[0]).toContain("SLAUDE_NODE_ALLOW_GATEWAY_SECRETS");
    expect(bad[1]).toContain("SLAUDE_NODE_BOOT_CHECK");
  });
});
