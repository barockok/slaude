import { beforeEach, describe, expect, test } from "bun:test";
import { __resetDmPlaceForTests, managerDmPlace } from "../../src/memory/dm-place";
import { placeSourceId, type PlaceRef } from "../../src/memory/place";

const dm: PlaceRef = { kind: "place", source: placeSourceId("A1", "bdm"), boundaryId: "bdm", boundaryKind: "dm" };
const base = { agentId: "A1", teamId: "T1", userId: "U1" };
beforeEach(() => __resetDmPlaceForTests());

describe("managerDmPlace", () => {
  test("opens the DM once per person and returns its dm place", async () => {
    let opened = 0;
    const open = async () => (opened++, "D1");
    const place = async () => dm;
    expect(await managerDmPlace({ ...base, open, place })).toEqual(dm);
    expect(await managerDmPlace({ ...base, open, place })).toEqual(dm);
    expect(opened).toBe(1);
  });
  test("no DM, a non-dm place, a throw or a slow answer all mean no DM place", async () => {
    expect(await managerDmPlace({ ...base, open: async () => null, place: async () => dm })).toBeUndefined();
    expect(await managerDmPlace({ ...base, userId: "U2", open: async () => "D2", place: async () => ({ ...dm, boundaryKind: "channel" }) })).toBeUndefined();
    expect(await managerDmPlace({ ...base, userId: "U3", open: async () => { throw new Error("x"); }, place: async () => dm })).toBeUndefined();
    expect(await managerDmPlace({ ...base, userId: "U4", open: () => new Promise<string>(() => {}), place: async () => dm, timeoutMs: 20 })).toBeUndefined();
    expect(await managerDmPlace({ ...base, userId: "U5", open: async () => "D5", place: async () => ({ kind: "none", reason: "no-boundary" }) })).toBeUndefined();
  });
});
