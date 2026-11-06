import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SoulDataSchema, type SoulData } from "../../src/soul/data";
import { __resetSoulDataMemo, setSoulData } from "../../src/soul/extract";
import { __resetPersonaRegistry, setPersonaRegistry, type Persona, type PersonaRegistry } from "../../src/persona/registry";
import { channelApproversOf, effectiveSoulForChannelFor, soulDataFor, withAclFallback } from "../../src/soul/per-persona";
import * as SO from "../../src/db/soul-overrides";

const soul = (d: Partial<SoulData> | Record<string, unknown>): SoulData => SoulDataSchema.parse(d);

const DEFAULT = soul({
  identity: { name: "Default" },
  manager: { userId: "UMGR" },
  backupManager: { userId: "UBAK" },
  trustedChannels: ["CTEAM"],
  allowedChannels: ["CPUB"],
  dmAllowedUsers: ["UDM"],
  blockedUsers: ["UBAD"],
  approvers: [{ userId: "UAPP", scope: "anything", catchall: true }],
  mandate: "default mandate",
  channelOverrides: [{ channel: "COPS", mandate: "ops mandate", approvers: [{ userId: "UOPS", scope: "deploys", catchall: false }] }],
});

function registryWith(personas: Array<Pick<Persona, "name"> & { soulJson?: unknown }>): PersonaRegistry {
  const full = personas.map((p) => ({ slackUserId: `UP${p.name.toUpperCase()}`, config: { slackUserId: "UX", name: p.name }, outClient: null, ...p }) as Persona);
  return {
    lookupByUserId: () => null,
    lookupByName: (n) => full.find((p) => p.name === n) ?? null,
    list: () => full,
    isMultiPersonaMode: () => full.length > 0,
    isManaged: () => true,
    tombstonedPersonaFor: () => null,
  };
}

beforeEach(async () => {
  await SO.clear();
  setSoulData(DEFAULT);
});
afterEach(() => {
  __resetPersonaRegistry();
  __resetSoulDataMemo();
});

describe("soulDataFor", () => {
  test("default persona (or none) is the process-wide default soul", () => {
    expect(soulDataFor("default")).toEqual(DEFAULT);
    expect(soulDataFor(undefined)).toEqual(DEFAULT);
    expect(soulDataFor(null)).toEqual(DEFAULT);
  });

  test("named persona without a structured soul takes the default's ACL fields only", () => {
    setPersonaRegistry(registryWith([{ name: "scout" }]));
    const s = soulDataFor("scout");
    expect(s.manager.userId).toBe("UMGR");
    expect(s.backupManager.userId).toBe("UBAK");
    expect(s.trustedChannels).toEqual(["CTEAM"]);
    expect(s.allowedChannels).toEqual(["CPUB"]);
    expect(s.dmAllowedUsers).toEqual(["UDM"]);
    expect(s.blockedUsers).toEqual(["UBAD"]);
    expect(s.approvers.map((a) => a.userId)).toEqual(["UAPP"]);
    // Channel approvers come along; the default's mandates do not.
    expect(s.channelOverrides).toEqual([{ channel: "COPS", approvers: [{ userId: "UOPS", scope: "deploys", catchall: false }] }]);
    expect(s.mandate).toBeUndefined();
    expect(s.identity).toEqual({});
  });

  test("unknown persona and an unparseable soul_json fall back the same way", () => {
    setPersonaRegistry(registryWith([{ name: "broken", soulJson: { manager: { userId: "not-an-id" } } }]));
    expect(soulDataFor("broken").manager.userId).toBe("UMGR");
    expect(soulDataFor("ghost").trustedChannels).toEqual(["CTEAM"]);
  });

  test("identity and mandate only: every ACL field is the default's, identity and mandate are its own", () => {
    setPersonaRegistry(registryWith([{ name: "scout", soulJson: { identity: { name: "Scout" }, mandate: "scout things" } }]));
    const s = soulDataFor("scout");
    expect(s.identity.name).toBe("Scout");
    expect(s.mandate).toBe("scout things");
    expect(s.manager.userId).toBe("UMGR");
    expect(s.trustedChannels).toEqual(["CTEAM"]);
    expect(s.blockedUsers).toEqual(["UBAD"]);
  });

  test("field-level: own values win where non-empty, the default fills the rest", () => {
    setPersonaRegistry(registryWith([{
      name: "scout",
      soulJson: { manager: { userId: "USCOUT" }, trustedChannels: ["CSCOUT"], approvers: [{ userId: "UREV", scope: "anything", catchall: true }] },
    }]));
    const s = soulDataFor("scout");
    expect(s.manager.userId).toBe("USCOUT");
    expect(s.backupManager.userId).toBe("UBAK");
    expect(s.trustedChannels).toEqual(["CSCOUT"]);
    expect(s.allowedChannels).toEqual(["CPUB"]);
    expect(s.dmAllowedUsers).toEqual(["UDM"]);
    expect(s.blockedUsers).toEqual(["UBAD"]);
    // Own approvers: the default's channel approver blocks are not inherited.
    expect(s.approvers.map((a) => a.userId)).toEqual(["UREV"]);
    expect(s.channelOverrides).toEqual([]);
  });

  test("own channel approvers count as own approvers; own channel mandates stay", () => {
    const own = soul({ channelOverrides: [{ channel: "CX", mandate: "x", approvers: [{ userId: "UX1", scope: "a", catchall: true }] }] });
    const s = withAclFallback(own, DEFAULT);
    expect(s.approvers).toEqual([]);
    expect(s.channelOverrides).toEqual(own.channelOverrides);
  });

  test("inherited channel approvers merge into the persona's own block for that channel", () => {
    const own = soul({ channelOverrides: [{ channel: "COPS", mandate: "scout ops" }] });
    const s = withAclFallback(own, DEFAULT);
    expect(s.channelOverrides).toEqual([{ channel: "COPS", mandate: "scout ops", approvers: [{ userId: "UOPS", scope: "deploys", catchall: false }] }]);
  });
});

describe("effectiveSoulForChannelFor", () => {
  test("default persona matches effectiveSoulForChannel: replace, manager and backup appended", () => {
    const s = effectiveSoulForChannelFor("default", "COPS");
    expect(s.mandate).toBe("ops mandate");
    expect(s.approvers.map((a) => a.userId)).toEqual(["UOPS", "UMGR", "UBAK"]);
    expect(effectiveSoulForChannelFor("default", "CTEAM").approvers.map((a) => a.userId)).toEqual(["UAPP"]);
    expect(effectiveSoulForChannelFor("default").approvers.map((a) => a.userId)).toEqual(["UAPP"]);
  });

  test("named persona uses its own manager when appending", () => {
    setPersonaRegistry(registryWith([{ name: "scout", soulJson: { manager: { userId: "USCOUT" }, mandate: "m" } }]));
    const s = effectiveSoulForChannelFor("scout", "COPS");
    expect(s.approvers.map((a) => a.userId)).toEqual(["UOPS", "USCOUT", "UBAK"]);
    expect(s.mandate).toBe("m");
  });

  test("channelApproversOf maps every replacing channel block", () => {
    expect([...channelApproversOf(DEFAULT)]).toEqual([["COPS", ["UOPS", "UMGR", "UBAK"]]]);
  });
});
