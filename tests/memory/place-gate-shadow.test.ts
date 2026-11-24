import { describe, expect, test } from "bun:test";
import { classifyBrainOp, type GateInput } from "../../src/knowledge/gated-dispatch";
import { resolveBrainScope, type ScopeInput } from "../../src/knowledge/scope";
import { memoryScopeFor } from "../../src/memory/scope";
import { NO_PLACE, placeSourceId, type PlaceRef } from "../../src/memory/place";

const PLACE: PlaceRef = { kind: "place", source: placeSourceId("agent1", "b1"), boundaryId: "b1", boundaryKind: "channel" };
const gate = (place: PlaceRef, o: Partial<GateInput> = {}): GateInput => ({
  userId: "U1", teamId: "T1", interactive: true, lockedUser: null, channelTrust: "trusted", isManager: false, agentId: "agent1", place, ...o,
});

describe("place is required and, in rc.45, decides nothing", () => {
  test("a caller that omits place does not typecheck", () => {
    // @ts-expect-error place is required on ScopeInput
    const s: ScopeInput = { userId: "U1", teamId: null, lockedUser: null, channelTrust: "trusted", isManager: false, kbSources: [], agentId: "a" };
    // @ts-expect-error place is required on GateInput
    const g: GateInput = { userId: "U1", teamId: null, interactive: true, lockedUser: null, channelTrust: "trusted", isManager: false, agentId: "a" };
    expect(s && g).toBeTruthy();
  });

  const cases: Array<[string, Partial<GateInput>]> = [
    ["trusted channel", {}],
    ["manager in a public channel", { channelTrust: "public", isManager: true }],
    ["public non-manager", { channelTrust: "public" }],
    ["someone else's lock", { lockedUser: "U2" }],
    ["own lock", { lockedUser: "U1" }],
    ["background turn", { userId: null }],
  ];
  for (const [name, o] of cases) {
    test(`resolveBrainScope is identical with a place and with none: ${name}`, async () => {
      const a = await resolveBrainScope({ ...gate(PLACE, o), kbSources: ["kb-x"] });
      const b = await resolveBrainScope({ ...gate(NO_PLACE, o), kbSources: ["kb-x"] });
      expect(a).toEqual(b);
      expect(JSON.stringify(a)).not.toContain("mb-");
    });
    test(`memoryScopeFor is identical with a place and with none: ${name}`, async () => {
      for (const channel of ["C1", "D1"]) {
        const a = await memoryScopeFor(gate(PLACE, o), { channel });
        const b = await memoryScopeFor(gate(NO_PLACE, o), { channel });
        expect(a).toEqual(b);
        expect(JSON.stringify(a)).not.toContain("mb-");
      }
    });
    test(`classifyBrainOp is identical with a place and with none: ${name}`, async () => {
      const scope = await resolveBrainScope({ ...gate(NO_PLACE, o), kbSources: [] });
      for (const op of ["put_page", "delete_page", "search", "sync_brain"]) {
        expect(await classifyBrainOp(op, scope, gate(PLACE, o))).toBe(await classifyBrainOp(op, scope, gate(NO_PLACE, o)));
      }
    });
  }
});
