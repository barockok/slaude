/**
 * The tool plane looks servers and tools up by OWN key only: a path segment
 * naming an Object.prototype member (`constructor`, `toString`, `__proto__`)
 * is an unknown server or tool (404), never a 500 from calling the inherited
 * member as an executor, and never a metric series.
 */
import { describe, expect, test } from "bun:test";
import { executeToolCall } from "../../../src/gateway/api/tools";
import type { JobClaims } from "../../../src/gateway/api/auth";
import { metrics } from "../../../src/metrics";

const claims = { tenant: "default", persona: "default", session: "S1", team: "T1", channel: "C1", thread: "1.0", initiator: "U1", scope: "turn", runAs: "agent", exp: 0 } as JobClaims;
const deps = {} as never;

describe("tool plane lookups by own key", () => {
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    test(`/v1/tools/${name}/x is an unknown server (404)`, async () => {
      const res = await executeToolCall(name, "x", {}, claims, deps);
      expect(res.status).toBe(404);
    });
    test(`/v1/tools/kb/${name} is an unknown tool (404)`, async () => {
      const res = await executeToolCall("kb", name, {}, claims, deps);
      expect(res.status).toBe(404);
    });
  }

  test("no tool-call series is counted for a prototype name", () => {
    expect(metrics.render()).not.toMatch(/slaude_v1_tool_calls_total\{[^}]*(constructor|toString|__proto__|hasOwnProperty)/);
  });
});
