import { describe, expect, test } from "bun:test";
import { mergeEffective, sameDesired, type DesiredPersona } from "../../src/persona/effective";

const desired: DesiredPersona = {
  name: "ana", slackUserId: "UTESTUSER1", userToken: null, model: "m-git",
  soulMd: "git soul", soulJson: { approvers: [] }, mcp: { a: 1 }, origin: "git", tombstonedAt: null,
};

describe("mergeEffective", () => {
  test("with no overrides it is the desired layer", () => {
    expect(mergeEffective(desired, [])).toEqual({ ...desired, overridden: [] });
  });

  test("a model override replaces only the model", () => {
    const e = mergeEffective(desired, [{ field: "model", value: "m-live" }]);
    expect(e.model).toBe("m-live");
    expect(e.soulMd).toBe("git soul");
    expect(e.overridden).toEqual(["model"]);
  });

  test("a soul override replaces text and structure together", () => {
    const e = mergeEffective(desired, [{ field: "soul", value: { soulMd: "live soul", soulJson: { approvers: ["x"] } } }]);
    expect(e.soulMd).toBe("live soul");
    expect(e.soulJson).toEqual({ approvers: ["x"] });
  });

  test("identity fields cannot be overridden by construction", () => {
    const e = mergeEffective(desired, [{ field: "slackUserId" as any, value: "UEVIL" }]);
    expect(e.slackUserId).toBe("UTESTUSER1");
  });
});

describe("sameDesired", () => {
  const base = { name: "ana", slackUserId: "UANA", userToken: null, model: null, soulMd: "s", soulJson: null, mcp: { a: 1 }, origin: "git" as const, tombstonedAt: null };
  test("equal on the synced fields, ignoring name and soulJson", () => {
    expect(sameDesired(base, { ...base, soulJson: { x: 1 } })).toBe(true);
  });
  test("differs on each synced field", () => {
    expect(sameDesired(base, { ...base, model: "m" })).toBe(false);
    expect(sameDesired(base, { ...base, soulMd: "t" })).toBe(false);
    expect(sameDesired(base, { ...base, slackUserId: "U2" })).toBe(false);
    expect(sameDesired(base, { ...base, userToken: "t" })).toBe(false);
    expect(sameDesired(base, { ...base, mcp: { a: 2 } })).toBe(false);
  });
  test("a tombstoned persona is never the same", () => {
    expect(sameDesired({ ...base, tombstonedAt: 5 }, base)).toBe(false);
  });
});
