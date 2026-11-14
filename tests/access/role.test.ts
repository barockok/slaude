import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SoulDataSchema, type SoulData } from "../../src/soul/data";
import { __resetSoulDataMemo, setSoulData } from "../../src/soul/extract";
import { __resetPersonaRegistry, setPersonaRegistry, type Persona, type PersonaRegistry } from "../../src/persona/registry";
import { deriveSoulGrants, effectiveGrants, type Grant } from "../../src/access/grants";
import { __setGrantsReader, approversFor, invalidateGrants, loadGrants, roleFromGrants, roleOf, usersWithRole } from "../../src/access/role";
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

  test("a read failure degrades to soul-only, counts, logs once, and is cached briefly", async () => {
    const before = failures();
    let fail = true;
    let reads = 0;
    __setGrantsReader(async () => {
      reads++;
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
      expect(reads).toBe(1); // the soul-only result is cached
      expect(failures()).toBe(before + 1);
      invalidateGrants("default"); // stands in for the 2 s failure TTL running out
      await roleOf("default", "UALICE");
      expect(failures()).toBe(before + 2);
    } finally {
      console.error = orig;
    }
    expect(errs.length).toBe(1); // logged at most once a minute
    fail = false;
    invalidateGrants("default");
    expect(await roleOf("default", "UALICE")).toBe("member");
  });

  test("a burst shares one in-flight read per persona", async () => {
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    __setGrantsReader(async () => {
      reads++;
      await gate;
      return [stored({ subjectKind: "user", subjectId: "UALICE" })];
    });
    const burst = Promise.all([roleOf("default", "UALICE"), roleOf("default", "UBOB"), roleOf(undefined, "UALICE")]);
    release();
    expect(await burst).toEqual(["member", null, "member"]);
    expect(reads).toBe(1);
  });

  test("soul derivation skips empty ids", () => {
    const s = soul({ manager: {}, trustedChannels: [] });
    const grants = deriveSoulGrants({ ...s, dmAllowedUsers: [""], blockedUsers: [""] }, new Map([["", ["UX"]], ["CX", ["", "UY"]]]));
    expect(grants.every((g) => g.subjectId && (g.channelId === undefined || g.channelId))).toBe(true);
    expect(grants.map((g) => g.subjectId)).toEqual(["UY"]);
  });
});

/**
 * Slice C, defect 3: until the access flip, no non-Slack subject reaches a
 * legacy list. A row planted by hand (the API and the repo refuse to write one)
 * must not come back as an approver id to DM, to match a click, or to fill an
 * allowlist.
 */
describe("non-Slack subjects never reach the legacy readers", () => {
  const MAIL = "email:a@example.com";
  const plant = async (persona: string, subjectId: string, role: string, extra: { deny?: boolean; kind?: string } = {}) => {
    const pg = (await import("../../src/db/schema")).dbDialect() === "pg";
    const cols = ["id", "persona", "subject_kind", "subject_id", "role", "deny", "dm_only", "created_by", "created_at"];
    const vals: unknown[] = [`plant-${Math.random()}`, persona, extra.kind ?? "user", subjectId, role, pg ? !!extra.deny : extra.deny ? 1 : 0, pg ? false : 0, "test", 1];
    if (pg) (cols.push("tenant_id"), vals.push("default"));
    await db.run(`INSERT INTO agent_grants (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, vals);
    invalidateGrants();
  };

  test("usersWithRole returns only Slack user ids, whatever the role", () => {
    const grants: Grant[] = [
      stored({ subjectKind: "user", subjectId: MAIL, role: "manager" }),
      stored({ subjectKind: "user", subjectId: "user:abc123", role: "approver" }),
      stored({ subjectKind: "user", subjectId: "slack:user:UWRITTEN", role: "approver" }),
      stored({ subjectKind: "user", subjectId: "+628123456789", role: "approver" }),
      stored({ subjectKind: "user", subjectId: "UALICE", role: "approver" }),
      stored({ subjectKind: "user", subjectId: "WGRID1", role: "manager" }),
    ];
    expect(usersWithRole(grants, ["approver", "manager"]).sort()).toEqual(["UALICE", "WGRID1"]);
    expect(usersWithRole(grants, ["manager"])).toEqual(["WGRID1"]);
  });

  test("a planted email approver row never appears in approversFor", async () => {
    const baseline = (await approversFor("scout")).sort();
    await plant("scout", MAIL, "approver");
    await plant("scout", MAIL, "manager");
    const ids = (await approversFor("scout")).sort();
    expect(ids).toEqual(baseline);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.some((i) => i.includes("@"))).toBe(false);
  });

  test("a real Slack approver beside a planted email approver is the whole list", async () => {
    await plant("scout", MAIL, "approver");
    await plant("scout", "UREAL", "approver");
    const ids = await approversFor("scout");
    expect(ids).toContain("UREAL");
    expect(ids.some((i) => i.includes("@"))).toBe(false);
  });

  test("a planted email deny or member row changes nobody's role", async () => {
    await plant("default", MAIL, "member", { deny: true });
    await plant("default", MAIL, "member");
    expect(await roleOf("default", "UMGR")).toBe("manager");
    expect(await roleOf("default", "UALICE")).toBeNull();
  });
});
