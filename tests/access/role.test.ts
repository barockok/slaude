import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SoulDataSchema, type SoulData } from "../../src/soul/data";
import { __resetSoulDataMemo, setSoulData } from "../../src/soul/extract";
import { __resetPersonaRegistry, setPersonaRegistry, type Persona, type PersonaRegistry } from "../../src/persona/registry";
import { effectiveGrants, type Grant } from "../../src/access/grants";
import { __setGrantsReader, invalidateGrants, loadGrants, roleFromGrants, roleOf } from "../../src/access/role";
import { db } from "../../src/db/schema";
import * as AgentGrants from "../../src/db/agent-grants";
import * as SO from "../../src/db/soul-overrides";
import { metrics } from "../../src/metrics";

const soul = (d: Record<string, unknown>): SoulData => SoulDataSchema.parse(d);

const DEFAULT = soul({
  manager: { userId: "UMGR" },
  backupManager: { userId: "UBAK" },
  trustedChannels: ["CTEAM"],
  dmAllowedUsers: ["UDM"],
  blockedUsers: ["UBAD"],
  approvers: [{ userId: "UAPP", scope: "anything", catchall: true }],
  channelOverrides: [{ channel: "COPS", approvers: [{ userId: "UOPS", scope: "deploys", catchall: false }] }],
});

const stored = (g: Partial<Grant> & Pick<Grant, "subjectKind" | "subjectId">): Grant => ({
  role: "member", deny: false, dmOnly: false, source: "console", ...g,
});

function failures(): number {
  const line = metrics.render().split("\n").find((l) => l.startsWith("slaude_grants_read_failures_total"));
  return line ? Number(line.split(" ").pop()) : 0;
}

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

beforeEach(async () => {
  await SO.clear();
  await db.run("DELETE FROM agent_grants");
  setSoulData(DEFAULT);
  __setGrantsReader(null);
});
afterEach(async () => {
  __setGrantsReader(null);
  __resetPersonaRegistry();
  __resetSoulDataMemo();
  await db.run("DELETE FROM agent_grants");
});

describe("roleFromGrants (soul only)", () => {
  const g = () => effectiveGrants("default", []);

  test("manager, backup, approver, DM-allowlisted member, nobody", () => {
    expect(roleFromGrants(g(), "UMGR")).toBe("manager");
    expect(roleFromGrants(g(), "UBAK", "COPS")).toBe("manager");
    expect(roleFromGrants(g(), "UAPP")).toBe("approver");
    expect(roleFromGrants(g(), "UDM")).toBe("member");
    expect(roleFromGrants(g(), "URANDOM")).toBeNull();
    expect(roleFromGrants(g(), "")).toBeNull();
  });

  test("a grant on the channel makes anyone a member there", () => {
    expect(roleFromGrants(g(), "URANDOM", "CTEAM")).toBe("member");
    expect(roleFromGrants(g(), "URANDOM", "CUNLISTED")).toBeNull();
  });

  test("blocked users have no role, even in a trusted channel", () => {
    expect(roleFromGrants(g(), "UBAD", "CTEAM")).toBeNull();
  });

  test("channel-scoped approvers replace the global ones in that channel only", () => {
    expect(roleFromGrants(g(), "UOPS", "COPS")).toBe("approver");
    expect(roleFromGrants(g(), "UOPS")).toBeNull();
    expect(roleFromGrants(g(), "UOPS", "CTEAM")).toBe("member"); // via the channel grant, not approval
    expect(roleFromGrants(g(), "UAPP", "COPS")).toBeNull(); // global approver replaced in COPS
    expect(roleFromGrants(g(), "UAPP", "CTEAM")).toBe("approver");
  });

  test("named persona: its own channel approvers, its own manager appended", () => {
    setPersonaRegistry(registryWith([{ name: "scout", soulJson: { manager: { userId: "USCOUT" }, channelOverrides: [{ channel: "CX", approvers: [{ userId: "UREV", scope: "a", catchall: true }] }] } }]));
    const grants = effectiveGrants("scout", []);
    expect(roleFromGrants(grants, "USCOUT", "CX")).toBe("manager");
    expect(roleFromGrants(grants, "UREV", "CX")).toBe("approver");
    expect(roleFromGrants(grants, "UAPP", "CTEAM")).toBe("member"); // own approvers: the default's are not inherited
    expect(roleFromGrants(grants, "UMGR")).toBeNull();
  });
});

describe("stored grants", () => {
  const g = (...s: Grant[]) => [...effectiveGrants("default", []), ...s];

  test("stored roles", () => {
    expect(roleFromGrants(g(stored({ subjectKind: "user", subjectId: "UALICE", role: "manager" })), "UALICE")).toBe("manager");
    expect(roleFromGrants(g(stored({ subjectKind: "user", subjectId: "UALICE", role: "approver" })), "UALICE")).toBe("approver");
    expect(roleFromGrants(g(stored({ subjectKind: "user", subjectId: "UALICE" })), "UALICE")).toBe("member");
    expect(roleFromGrants(g(stored({ subjectKind: "workspace", subjectId: "TWORK" })), "UALICE")).toBe("member");
  });

  test("a stored approver is not channel scoped: it counts in a replaced channel too", () => {
    expect(roleFromGrants(g(stored({ subjectKind: "user", subjectId: "UALICE", role: "approver" })), "UALICE", "COPS")).toBe("approver");
  });

  test("a stored deny removes every role, the manager's included", () => {
    expect(roleFromGrants(g(stored({ subjectKind: "user", subjectId: "UMGR", deny: true })), "UMGR")).toBeNull();
    expect(roleFromGrants(g(stored({ subjectKind: "user", subjectId: "UAPP", deny: true })), "UAPP", "CTEAM")).toBeNull();
  });
});

describe("roleOf and the stored-grant loader", () => {
  test("reads stored grants from the repo; create and revoke invalidate the cache", async () => {
    expect(await roleOf("default", "UALICE")).toBeNull();
    const row = await AgentGrants.create({ persona: "default", subjectKind: "user", subjectId: "UALICE", role: "approver", createdBy: "UMGR" });
    expect(await roleOf("default", "UALICE")).toBe("approver");
    expect(await roleOf(undefined, "UALICE")).toBe("approver");
    expect(await roleOf("scout", "UALICE")).toBeNull(); // keyed by persona
    await AgentGrants.revoke(row.id);
    expect(await roleOf("default", "UALICE")).toBeNull();
  });

  test("cached within the TTL until invalidated", async () => {
    let reads = 0;
    __setGrantsReader(async () => {
      reads++;
      return [stored({ subjectKind: "user", subjectId: "UALICE" })];
    });
    await roleOf("default", "UALICE");
    await roleOf("default", "UBOB");
    expect(reads).toBe(1);
    invalidateGrants("default");
    await roleOf("default", "UALICE");
    expect(reads).toBe(2);
  });

  test("a read failure degrades to soul-only, counts, and is not cached", async () => {
    const before = failures();
    let fail = true;
    __setGrantsReader(async () => {
      if (fail) throw new Error("db down");
      return [stored({ subjectKind: "user", subjectId: "UALICE" })];
    });
    const errs: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errs.push(a);
    try {
      expect(await roleOf("default", "UMGR")).toBe("manager");
      expect(await roleOf("default", "UAPP", "CTEAM")).toBe("approver");
      expect(await roleOf("default", "UALICE")).toBeNull();
      const grants = await loadGrants("default");
      expect(grants.every((g) => g.source === "soul")).toBe(true);
    } finally {
      console.error = orig;
    }
    expect(failures()).toBe(before + 4);
    expect(errs.length).toBe(1); // logged at most once a minute
    fail = false;
    expect(await roleOf("default", "UALICE")).toBe("member");
  });
});
