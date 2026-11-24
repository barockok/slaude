import { describe, expect, test } from "bun:test";
import { isAgentLike, isPersonSource, remapSource } from "../../src/brain-migrate/remap";
import { storeLabel } from "../../src/knowledge/memory-browse";
import { storeKind } from "../../src/knowledge/scope";
import { runAsOf } from "../../src/proactive/commitment-index";
import { placeSourceId } from "../../src/memory/place";

const PLACE = placeSourceId("agent1", "b1");

describe("a place source among the other store kinds", () => {
  test("storeKind recognises the mb- prefix and nothing else changed", () => {
    expect(storeKind(PLACE)).toBe("place");
    expect(["agent", "agent-x", "shared", "public", "user-a", "profile-t-u", "kb-x", "default"].map(storeKind)).toEqual(["agent", "agent", "shared", "public", "personal", "profile", "library", "other"]);
  });
  test("the console labels it by a short id", () => {
    expect(storeLabel(PLACE)).toBe(`Place: ${PLACE.slice(3, 11)}`);
  });
  test("it is not agent-like or a person source, so a brain migration maps it to nothing", () => {
    expect(isAgentLike(PLACE)).toBe(false);
    expect(isPersonSource(PLACE)).toBe(false);
    expect(remapSource(PLACE, { agentSource: "agent-x" })).toEqual({ ok: false, code: "no_mapping", source: PLACE });
  });
  test("it is never a person's run-as identity", () => {
    expect(runAsOf({ sourceId: PLACE, clientId: "U1" })).toBeNull();
  });
});
