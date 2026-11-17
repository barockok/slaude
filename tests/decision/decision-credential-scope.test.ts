import { describe, expect, test } from "bun:test";
import { isChildScrubbedEnv, scrubChildEnv } from "../../src/agent/child-env";
import { isGatewayOnlyEnv } from "../../src/config/gateway-only-env";

describe("a decision adapter's secret reference stays in the gateway", () => {
  test("a PERSONA_* variable (what env:// references may name) is gateway only: no agent child and no node holds it", () => {
    expect(isGatewayOnlyEnv("PERSONA_DECISION_API_KEY")).toBe(true);
    expect(isChildScrubbedEnv("PERSONA_DECISION_API_KEY")).toBe(true);
    const out = scrubChildEnv({ PERSONA_DECISION_API_KEY: "v", PATH: "/bin" });
    expect(out.PERSONA_DECISION_API_KEY).toBeUndefined();
    expect(out.PATH).toBe("/bin");
  });
});
