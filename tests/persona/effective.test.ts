import { describe, expect, test } from "bun:test";
import { mergeEffective, type DesiredPersona } from "../../src/persona/effective";

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
