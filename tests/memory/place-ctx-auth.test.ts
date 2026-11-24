import { describe, expect, test } from "bun:test";
import { buildScopedCtxAuth } from "../../src/knowledge/brain";
import type { BrainScope } from "../../src/knowledge/scope";
import { placeSourceId } from "../../src/memory/place";

const A = placeSourceId("agent1", "b1");
const B = placeSourceId("agent1", "b2");
const scope = (o: Partial<BrainScope>): BrainScope => ({ clientId: "agent1", sourceId: "agent-x", allowedSources: ["agent-x", "shared"], ...o });

describe("buildScopedCtxAuth names at most one memory place", () => {
  test("no place, or one place (as write target, in the reads, or both), builds", () => {
    expect(() => buildScopedCtxAuth(scope({}))).not.toThrow();
    expect(() => buildScopedCtxAuth(scope({ allowedSources: ["agent-x", A] }))).not.toThrow();
    expect(() => buildScopedCtxAuth(scope({ sourceId: A, allowedSources: [A, "shared"] }))).not.toThrow();
    expect(buildScopedCtxAuth(scope({ sourceId: A, allowedSources: [A, A] })).sourceId).toBe(A);
  });
  test("two different places in the reads throw", () => {
    expect(() => buildScopedCtxAuth(scope({ allowedSources: ["agent-x", A, B] }))).toThrow(/more than one memory place/);
  });
  test("a write target in one place with a read of another throws", () => {
    expect(() => buildScopedCtxAuth(scope({ sourceId: A, allowedSources: [A, B] }))).toThrow(/more than one memory place/);
    expect(() => buildScopedCtxAuth(scope({ sourceId: B, allowedSources: ["shared", A] }))).toThrow(/more than one memory place/);
  });
});
