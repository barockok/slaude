import { describe, expect, test } from "bun:test";
import { buildScopedCtxAuth, runAdminOp, runScopedOp } from "../src/knowledge/brain";
import type { BrainScope } from "../src/knowledge/scope";

describe("brain runop primitives", () => {
  test("runScopedOp / runAdminOp are exported functions", () => {
    expect(typeof runScopedOp).toBe("function");
    expect(typeof runAdminOp).toBe("function");
  });

  test("buildScopedCtxAuth shapes synthetic auth from scope", () => {
    const scope: BrainScope = {
      clientId: "agent",
      sourceId: "agent",
      allowedSources: ["agent", "shared", "public"],
    };
    const auth = buildScopedCtxAuth(scope);
    expect(auth).toEqual({
      token: "in-process",
      clientId: "agent",
      clientName: "agent",
      scopes: ["read", "write"],
      sourceId: "agent",
      allowedSources: ["agent", "shared", "public"],
    });
  });
});
