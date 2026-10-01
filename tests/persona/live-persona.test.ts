// R41 (I4): one rule for "which persona is this", shared by every caller that
// used to fall back to the default: on a managed registry, a named persona that
// is absent or retired is refused, never defaulted.
import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetPersonaRegistry, livePersona, onPersonaRegistryInstalled, PersonaNotLiveError, setPersonaRegistry, type PersonaRegistry,
} from "../../src/persona/registry";

const ana = { name: "ana", slackUserId: "UTESTANA1", soulMd: "s", config: { slackUserId: "UTESTANA1", name: "ana" }, outClient: null };
const reg = (managed: boolean, withAna: boolean): PersonaRegistry => ({
  lookupByUserId: () => null, lookupByName: (n) => (withAna && n === "ana" ? ana : null), list: () => (withAna ? [ana] : []),
  isMultiPersonaMode: () => withAna, isManaged: () => managed, tombstonedPersonaFor: () => null,
});

afterEach(() => __resetPersonaRegistry());

describe("livePersona", () => {
  test("a live persona is returned", () => {
    setPersonaRegistry(reg(true, true));
    expect(livePersona("ana")).toBe(ana);
  });
  test("managed and missing: refused, naming the persona", () => {
    setPersonaRegistry(reg(true, false));
    expect(() => livePersona("ana")).toThrow(PersonaNotLiveError);
    expect(() => livePersona("ana")).toThrow(/ana/);
  });
  test("unmanaged and missing: null, the filesystem fallback is unchanged", () => {
    setPersonaRegistry(reg(false, false));
    expect(livePersona("ana")).toBeNull();
  });
});

describe("onPersonaRegistryInstalled", () => {
  test("fires with the installed registry; unsubscribe stops it", () => {
    const seen: PersonaRegistry[] = [];
    const off = onPersonaRegistryInstalled((r) => seen.push(r));
    const a = reg(true, true);
    setPersonaRegistry(a);
    off();
    setPersonaRegistry(reg(false, false));
    expect(seen).toEqual([a]);
  });
  test("a throwing listener does not stop the install or other listeners", () => {
    const seen: string[] = [];
    const off1 = onPersonaRegistryInstalled(() => { throw new Error("boom"); });
    const off2 = onPersonaRegistryInstalled(() => seen.push("ok"));
    try {
      setPersonaRegistry(reg(true, true));
      expect(seen).toEqual(["ok"]);
    } finally { off1(); off2(); }
  });
});
