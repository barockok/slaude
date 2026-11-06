import { beforeEach, describe, expect, test } from "bun:test";
import { db, dbDialect } from "../../src/db/schema";
import * as AgentGrants from "../../src/db/agent-grants";

beforeEach(async () => {
  await db.run("DELETE FROM agent_grants");
});

const base = { persona: "scout", subjectKind: "user", subjectId: "UALICE", role: "member", createdBy: "UMGR" } as const;

describe("agent_grants repo", () => {
  test("create returns the row; listForPersona reads it back", async () => {
    const g = await AgentGrants.create({ ...base, note: "pairing" });
    expect(g.id).toMatch(/.+/);
    expect(g.createdAt).toBeGreaterThan(0);
    expect(g).toMatchObject({ persona: "scout", subjectKind: "user", subjectId: "UALICE", role: "member", deny: false, dmOnly: false, createdBy: "UMGR", expiresAt: null, note: "pairing" });
    expect(await AgentGrants.listForPersona("scout", Date.now())).toEqual([g]);
    expect(await AgentGrants.listForPersona("other", Date.now())).toEqual([]);
  });

  test("deny and dm_only round trip as booleans", async () => {
    await AgentGrants.create({ ...base, subjectId: "UBOB", deny: true });
    await AgentGrants.create({ ...base, subjectId: "UCAROL", dmOnly: true });
    const rows = await AgentGrants.listForPersona("scout", Date.now());
    const by = Object.fromEntries(rows.map((r) => [r.subjectId, r]));
    expect(by.UBOB).toMatchObject({ deny: true, dmOnly: false });
    expect(by.UCAROL).toMatchObject({ deny: false, dmOnly: true });
  });

  test("expired grants are filtered at read time; no sweep", async () => {
    const now = 1_000_000;
    await AgentGrants.create({ ...base, subjectId: "UOLD", expiresAt: now - 1 });
    await AgentGrants.create({ ...base, subjectId: "UEDGE", expiresAt: now });
    await AgentGrants.create({ ...base, subjectId: "ULATER", expiresAt: now + 1 });
    await AgentGrants.create({ ...base, subjectId: "UEVER" });
    const live = (await AgentGrants.listForPersona("scout", now)).map((r) => r.subjectId).sort();
    expect(live).toEqual(["UEVER", "ULATER"]);
    expect((await AgentGrants.listAll()).length).toBe(4);
  });

  test("listAll spans personas", async () => {
    await AgentGrants.create(base);
    await AgentGrants.create({ ...base, persona: "default", subjectKind: "channel", subjectId: "CTEAM" });
    expect((await AgentGrants.listAll()).map((r) => r.persona).sort()).toEqual(["default", "scout"]);
  });

  test("revoke hard deletes and reports whether a row went", async () => {
    const g = await AgentGrants.create(base);
    expect(await AgentGrants.revoke(g.id)).toBe(true);
    expect(await AgentGrants.revoke(g.id)).toBe(false);
    expect(await AgentGrants.listAll()).toEqual([]);
  });

  test("create validates role and subject kind", async () => {
    await expect(AgentGrants.create({ ...base, role: "owner" as never })).rejects.toThrow(/role/);
    await expect(AgentGrants.create({ ...base, subjectKind: "group" as never })).rejects.toThrow(/subject_kind/);
    await expect(AgentGrants.create({ ...base, subjectId: "" })).rejects.toThrow(/subject_id/);
    await expect(AgentGrants.create({ ...base, persona: "" })).rejects.toThrow(/persona/);
    expect(await AgentGrants.listAll()).toEqual([]);
  });

  test("tenant is written and filtered on Postgres only", async () => {
    await AgentGrants.create({ ...base, tenantId: "t2" });
    await AgentGrants.create({ ...base, subjectId: "UBOB" });
    const t2 = await AgentGrants.listForPersona("scout", Date.now(), "t2");
    const dflt = await AgentGrants.listForPersona("scout", Date.now());
    if (dbDialect() === "pg") {
      expect(t2.map((r) => r.subjectId)).toEqual(["UALICE"]);
      expect(dflt.map((r) => r.subjectId)).toEqual(["UBOB"]);
      expect((await AgentGrants.listAll("t2")).length).toBe(1);
    } else {
      expect(t2.length).toBe(2);
      expect(dflt.length).toBe(2);
    }
    expect((await AgentGrants.listAll()).length).toBe(2);
  });
});
