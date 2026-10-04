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
  test("differs on provider references; absent and null are the same", () => {
    const withRef = { ...base, provider: { apiKey: "env://PERSONA_ANA_KEY" } };
    expect(sameDesired(base, withRef)).toBe(false);
    expect(sameDesired(withRef, { ...base, provider: { apiKey: "env://PERSONA_ANA_KEY2" } })).toBe(false);
    expect(sameDesired(withRef, { ...base, provider: { apiKey: "env://PERSONA_ANA_KEY" } })).toBe(true);
    expect(sameDesired(base, { ...base, provider: null })).toBe(true);
  });
  test("provider is not overridable: an override naming it changes nothing", () => {
    const d = { ...base, provider: { apiKey: "env://PERSONA_ANA_KEY" } };
    const e = mergeEffective(d, [{ field: "provider" as any, value: { apiKey: "env://PERSONA_EVIL" } }]);
    expect(e.provider).toEqual({ apiKey: "env://PERSONA_ANA_KEY" });
    expect(e.overridden).toEqual([]);
  });
  test("differs on kbSources; absent and null (all KBs) are the same, [] (none) is not", () => {
    const withKb = { ...base, kbSources: ["kb-a", "kb-b"] };
    expect(sameDesired(base, withKb)).toBe(false);
    expect(sameDesired(withKb, { ...base, kbSources: ["kb-a"] })).toBe(false);
    expect(sameDesired(withKb, { ...base, kbSources: ["kb-a", "kb-b"] })).toBe(true);
    expect(sameDesired(base, { ...base, kbSources: null })).toBe(true);
    expect(sameDesired(base, { ...base, kbSources: [] })).toBe(false);
  });
  test("kbSources is not overridable: an override naming it changes nothing", () => {
    const d = { ...base, kbSources: ["kb-a"] };
    const e = mergeEffective(d, [{ field: "kbSources" as any, value: null }]);
    expect(e.kbSources).toEqual(["kb-a"]);
    expect(e.overridden).toEqual([]);
  });
  test("a tombstoned persona is never the same", () => {
    expect(sameDesired({ ...base, tombstonedAt: 5 }, base)).toBe(false);
  });
});

describe("runsOn (node labels spec §4.5)", () => {
  const base: DesiredPersona = { ...desired, runsOn: "engineering" };
  test("a change of label is a change, and null equals absent (both are default)", () => {
    expect(sameDesired(base, { ...base, runsOn: "finance" })).toBe(false);
    expect(sameDesired(base, { ...base, runsOn: null })).toBe(false);
    expect(sameDesired({ ...desired, runsOn: null }, desired)).toBe(true);
  });
  test("no override can set it: an override naming runsOn is ignored", () => {
    const e = mergeEffective(base, [{ field: "runsOn" as any, value: "finance" }]);
    expect(e.runsOn).toBe("engineering");
    expect(e.overridden).toEqual([]);
  });
});
