import { describe, expect, test, beforeAll, beforeEach, afterAll, afterEach } from "bun:test";
import { setSoulData, __resetSoulDataMemo } from "../../src/soul/extract";
import { SoulDataSchema } from "../../src/soul/data";
import { canDecidePermission, type PermissionDeciderArgs } from "../../src/access/permission-auth";
import { __setGrantsReader } from "../../src/access/role";
import { __resetPersonaRegistry, setPersonaRegistry, type Persona, type PersonaRegistry } from "../../src/persona/registry";

const any = (userId: string) => ({ userId, scope: "anything", catchall: true });

const DEFAULT_SOUL = () =>
  SoulDataSchema.parse({
    manager: { userId: "UMGR" },
    backupManager: { userId: "UBACKUP" },
    approvers: [any("UGLOBAL")],
    channelOverrides: [
      { channel: "CTEAM", approvers: [any("UCHANAPP")] },
      { channel: "COTHER", approvers: [any("UOTHERAPP")] },
    ],
  });
beforeAll(() => __setGrantsReader(async () => []));
// __resetPersonaRegistry also drops the soul memo: set the default soul per test.
beforeEach(() => setSoulData(DEFAULT_SOUL()));
afterAll(() => {
  __resetSoulDataMemo();
  __setGrantsReader(null);
});

const base: Omit<PermissionDeciderArgs, "clicker"> = { initiator: "UALICE", lockOwner: null, persona: "default", channel: "CTEAM" };

describe("canDecidePermission", () => {
  const cases: [string, Partial<PermissionDeciderArgs> & { clicker: string }, boolean][] = [
    ["the initiator", { clicker: "UALICE" }, true],
    ["the /1on1 lock owner", { clicker: "UOWNER", lockOwner: "UOWNER" }, true],
    ["the manager", { clicker: "UMGR" }, true],
    ["the backup manager", { clicker: "UBACKUP" }, true],
    ["a global approver in a channel with no approver block", { clicker: "UGLOBAL", channel: "CPLAIN" }, true],
    ["a global approver where the channel block replaces the approvers", { clicker: "UGLOBAL" }, false],
    ["an approver of this channel", { clicker: "UCHANAPP" }, true],
    ["an approver of another channel", { clicker: "UOTHERAPP" }, false],
    ["a random member", { clicker: "UBOB" }, false],
    ["a random member when there is no initiator", { clicker: "UBOB", initiator: null }, false],
    ["an approver when there is no initiator", { clicker: "UCHANAPP", initiator: null }, true],
    ["the manager when there is no initiator", { clicker: "UMGR", initiator: null }, true],
    ["a member with no initiator and no lock (never matches null)", { clicker: "UBOB", initiator: null, lockOwner: null }, false],
  ];
  for (const [name, args, want] of cases) {
    test(`${name} -> ${want ? "may decide" : "refused"}`, async () => {
      expect(await canDecidePermission({ ...base, ...args })).toBe(want);
    });
  }

  test("an empty clicker is refused", async () => {
    expect(await canDecidePermission({ ...base, clicker: "", initiator: null })).toBe(false);
  });
});

function registryWith(personas: Array<{ name: string; soulJson?: unknown }>): PersonaRegistry {
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

describe("canDecidePermission for a named persona", () => {
  afterEach(() => __resetPersonaRegistry());
  const card = { initiator: null, lockOwner: null, channel: "CTEAM" } as const;

  test("its own manager decides; the default's manager does not when it names its own", async () => {
    setPersonaRegistry(registryWith([{ name: "noah", soulJson: { manager: { userId: "UNOAHMGR" } } }]));
    expect(await canDecidePermission({ ...card, persona: "noah", clicker: "UNOAHMGR" })).toBe(true);
    expect(await canDecidePermission({ ...card, persona: "noah", clicker: "UMGR" })).toBe(false);
    expect(await canDecidePermission({ ...card, persona: "noah", clicker: "UBACKUP" })).toBe(false);
  });

  test("a persona that names no manager falls back to the default's", async () => {
    setPersonaRegistry(registryWith([{ name: "noah", soulJson: { identity: { name: "Noah" } } }]));
    expect(await canDecidePermission({ ...card, persona: "noah", clicker: "UMGR" })).toBe(true);
  });
});
