import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SoulDataSchema, type SoulData } from "../../src/soul/data";
import { __resetSoulDataMemo, setSoulData } from "../../src/soul/extract";
import { __resetPersonaRegistry, setPersonaRegistry, type Persona, type PersonaRegistry } from "../../src/persona/registry";
import { admit } from "../../src/access/admission";
import { deriveSoulGrants, effectiveGrants, type Grant } from "../../src/access/grants";
import { channelApproversOf } from "../../src/soul/per-persona";
import { invalidateGrants, loadGrants } from "../../src/access/role";
import { db } from "../../src/db/schema";
import * as AgentGrants from "../../src/db/agent-grants";
import * as SO from "../../src/db/soul-overrides";

const soul = (d: Record<string, unknown>): SoulData => SoulDataSchema.parse(d);

const DEFAULT = soul({
  manager: { userId: "UMGR" },
  backupManager: { userId: "UBAK" },
  trustedChannels: ["CTEAM"],
  allowedChannels: ["CPUB"],
  dmAllowedUsers: ["UDM"],
  blockedUsers: ["UBAD"],
  approvers: [{ userId: "UAPP", scope: "anything", catchall: true }],
  channelOverrides: [{ channel: "COPS", approvers: [{ userId: "UOPS", scope: "deploys", catchall: false }] }],
});

/**
 * Reference oracle: the gateway's admission before grants (the blocklist step of
 * preTurnDropReason, then channelModeAdmits), copied verbatim in behaviour.
 */
function channelModeAdmits(s: SoulData, channelId: string, channelType: string, userId: string): boolean {
  const isDM = channelType === "im";
  const publicZone = !isDM && (s.trustedChannels.includes(channelId) || s.allowedChannels.includes(channelId));
  if (publicZone) return true;
  const managerId = s.manager.userId;
  const backupId = s.backupManager.userId;
  const dmAllowed = isDM && s.dmAllowedUsers.includes(userId);
  return Boolean((managerId && userId === managerId) || (backupId && userId === backupId) || dmAllowed);
}
function oldAdmission(s: SoulData, channelId: string, isDM: boolean, userId: string): string {
  if (s.blockedUsers.includes(userId)) return "blocked_user";
  return channelModeAdmits(s, channelId, isDM ? "im" : "channel", userId) ? "ok" : "whitelist";
}
const outcome = (r: ReturnType<typeof admit>) => (r.ok ? "ok" : r.reason);

const soulOnly = (s: SoulData) => deriveSoulGrants(s, channelApproversOf(s));
const stored = (g: Partial<Grant> & Pick<Grant, "subjectKind" | "subjectId">): Grant => ({
  role: "member", deny: false, dmOnly: false, source: "console", ...g,
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

const USERS = ["UMGR", "UBAK", "UDM", "UBAD", "UAPP", "UOPS", "URANDOM"];
const CHANNELS = ["CTEAM", "CPUB", "COPS", "CUNLISTED", "DDIRECT"];

beforeEach(async () => {
  await SO.clear();
  setSoulData(DEFAULT);
  invalidateGrants();
});
afterEach(() => {
  __resetPersonaRegistry();
  __resetSoulDataMemo();
  invalidateGrants();
});

describe("admission parity with channelModeAdmits + blocklist (no stored grants)", () => {
  const SOULS: Record<string, SoulData> = {
    full: DEFAULT,
    noManager: soul({ trustedChannels: ["CTEAM"], dmAllowedUsers: ["UDM"] }),
    blockedManager: soul({ manager: { userId: "UMGR" }, blockedUsers: ["UMGR"], allowedChannels: ["CPUB"] }),
    dmChannelListed: soul({ manager: { userId: "UMGR" }, trustedChannels: ["DDIRECT"], dmAllowedUsers: ["UDM"] }),
    empty: soul({}),
  };
  for (const [name, s] of Object.entries(SOULS)) {
    test(`grid: ${name}`, () => {
      const grants = soulOnly(s);
      for (const u of USERS) for (const c of CHANNELS) for (const isDM of [true, false]) {
        const got = outcome(admit({ grants, userId: u, channelId: c, isDM }));
        expect(`${u}/${c}/${isDM}=${got}`).toBe(`${u}/${c}/${isDM}=${oldAdmission(s, c, isDM, u)}`);
      }
    });
  }

  test("default persona via effectiveGrants matches the oracle", () => {
    const grants = effectiveGrants("default", []);
    for (const u of USERS) for (const c of CHANNELS) for (const isDM of [true, false]) {
      expect(outcome(admit({ grants, userId: u, channelId: c, isDM }))).toBe(oldAdmission(DEFAULT, c, isDM, u));
    }
  });
});

describe("admission truth table", () => {
  const g = () => effectiveGrants("default", []);
  const run = (grants: Grant[], userId: string, channelId: string, isDM: boolean) => outcome(admit({ grants, userId, channelId, isDM }));

  test("trusted and allowed channels admit anyone not blocked", () => {
    expect(run(g(), "URANDOM", "CTEAM", false)).toBe("ok");
    expect(run(g(), "URANDOM", "CPUB", false)).toBe("ok");
    expect(run(g(), "UBAD", "CTEAM", false)).toBe("blocked_user");
  });

  test("unlisted channel and DM: manager and backup only, plus the DM allowlist in DMs", () => {
    expect(run(g(), "UMGR", "CUNLISTED", false)).toBe("ok");
    expect(run(g(), "UBAK", "DDIRECT", true)).toBe("ok");
    expect(run(g(), "UDM", "DDIRECT", true)).toBe("ok");
    expect(run(g(), "UDM", "CUNLISTED", false)).toBe("whitelist");
    expect(run(g(), "URANDOM", "DDIRECT", true)).toBe("whitelist");
  });

  test("approver alone is not admitted in a DM or an unlisted channel", () => {
    expect(run(g(), "UAPP", "DDIRECT", true)).toBe("whitelist");
    expect(run(g(), "UAPP", "CUNLISTED", false)).toBe("whitelist");
    expect(run(g(), "UOPS", "COPS", false)).toBe("whitelist");
    expect(run([...g(), stored({ subjectKind: "user", subjectId: "UAPP", role: "approver" })], "UAPP", "DDIRECT", true)).toBe("whitelist");
  });

  test("stored member grant admits in an unlisted channel and in a DM", () => {
    const grants = [...g(), stored({ subjectKind: "user", subjectId: "UALICE" })];
    expect(run(grants, "UALICE", "CUNLISTED", false)).toBe("ok");
    expect(run(grants, "UALICE", "DDIRECT", true)).toBe("ok");
  });

  test("stored dm-only member admits only in a DM", () => {
    const grants = [...g(), stored({ subjectKind: "user", subjectId: "UALICE", dmOnly: true })];
    expect(run(grants, "UALICE", "DDIRECT", true)).toBe("ok");
    expect(run(grants, "UALICE", "CUNLISTED", false)).toBe("whitelist");
  });

  test("stored deny beats a trusted channel and the manager role", () => {
    const grants = [...g(), stored({ subjectKind: "user", subjectId: "UBOB", deny: true }), stored({ subjectKind: "user", subjectId: "UMGR", deny: true })];
    expect(run(grants, "UBOB", "CTEAM", false)).toBe("blocked_user");
    expect(run(grants, "UMGR", "CUNLISTED", false)).toBe("blocked_user");
  });

  test("stored channel grant and workspace grant admit in non-DM channels only", () => {
    const ch = [...g(), stored({ subjectKind: "channel", subjectId: "CUNLISTED" })];
    expect(run(ch, "URANDOM", "CUNLISTED", false)).toBe("ok");
    expect(run(ch, "URANDOM", "COTHER", false)).toBe("whitelist");
    const ws = [...g(), stored({ subjectKind: "workspace", subjectId: "TWORK" })];
    expect(run(ws, "URANDOM", "CUNLISTED", false)).toBe("ok");
    expect(run(ws, "URANDOM", "DDIRECT", true)).toBe("whitelist");
    expect(run(ws, "UBAD", "CUNLISTED", false)).toBe("blocked_user");
  });

  test("a stored manager grant admits anywhere", () => {
    const grants = [...g(), stored({ subjectKind: "user", subjectId: "UALICE", role: "manager" })];
    expect(run(grants, "UALICE", "DDIRECT", true)).toBe("ok");
    expect(run(grants, "UALICE", "CUNLISTED", false)).toBe("ok");
  });

  test("an expired stored grant is ignored (filtered by the repo)", async () => {
    await db.run("DELETE FROM agent_grants");
    await AgentGrants.create({ persona: "default", subjectKind: "user", subjectId: "UOLD", role: "member", createdBy: "UMGR", expiresAt: Date.now() - 1000 });
    await AgentGrants.create({ persona: "default", subjectKind: "user", subjectId: "UNEW", role: "member", createdBy: "UMGR", expiresAt: Date.now() + 60_000 });
    const grants = await loadGrants("default");
    expect(run(grants, "UOLD", "CUNLISTED", false)).toBe("whitelist");
    expect(run(grants, "UNEW", "CUNLISTED", false)).toBe("ok");
    await db.run("DELETE FROM agent_grants");
  });
});

describe("named personas", () => {
  test("a soul_json carrying only identity and mandate admits exactly like the default", () => {
    setPersonaRegistry(registryWith([{ name: "scout", soulJson: { identity: { name: "Scout" }, mandate: "scout things" } }]));
    const named = effectiveGrants("scout", []);
    const dflt = effectiveGrants("default", []);
    for (const u of USERS) for (const c of CHANNELS) for (const isDM of [true, false]) {
      expect(outcome(admit({ grants: named, userId: u, channelId: c, isDM }))).toBe(outcome(admit({ grants: dflt, userId: u, channelId: c, isDM })));
    }
  });

  test("a persona with no structured soul admits exactly like the default", () => {
    setPersonaRegistry(registryWith([{ name: "scout" }]));
    const named = effectiveGrants("scout", []);
    for (const u of USERS) for (const c of CHANNELS) for (const isDM of [true, false]) {
      expect(outcome(admit({ grants: named, userId: u, channelId: c, isDM }))).toBe(oldAdmission(DEFAULT, c, isDM, u));
    }
  });

  test("own manager and channels are its own units; other fields take the default's", () => {
    setPersonaRegistry(registryWith([{ name: "scout", soulJson: { manager: { userId: "USCOUT" }, trustedChannels: ["CSCOUT"] } }]));
    const grants = effectiveGrants("scout", []);
    const run = (u: string, c: string, isDM: boolean) => outcome(admit({ grants, userId: u, channelId: c, isDM }));
    expect(run("USCOUT", "CUNLISTED", false)).toBe("ok");
    expect(run("UMGR", "CUNLISTED", false)).toBe("whitelist"); // the default's manager is not scout's
    expect(run("UBAK", "CUNLISTED", false)).toBe("whitelist"); // managers are one unit: backup not inherited
    expect(run("URANDOM", "CSCOUT", false)).toBe("ok");
    expect(run("URANDOM", "CTEAM", false)).toBe("whitelist"); // own trusted list replaces the default's
    expect(run("URANDOM", "CPUB", false)).toBe("whitelist"); // channels are one unit: allowed list not inherited
    expect(run("UDM", "DDIRECT", true)).toBe("ok"); // DM allowlist inherited
    expect(run("UBAD", "CSCOUT", false)).toBe("blocked_user"); // blocklist inherited
  });
});
