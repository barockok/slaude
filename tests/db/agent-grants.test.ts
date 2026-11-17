import { beforeEach, describe, expect, test } from "bun:test";
import { db, dbDialect } from "../../src/db/schema";
import * as AgentGrants from "../../src/db/agent-grants";
import * as Domain from "../../src/db/domain";

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
    // Slack id shape per kind: uppercase alphanumerics after the kind's prefix.
    for (const [kind, ok, bad] of [
      ["user", ["UALICE", "WGRID1"], ["alice", "ualice", "CTEAM", "U", "U-1"]],
      ["channel", ["CTEAM", "GPRIV"], ["UALICE", "cteam", "#team"]],
      ["workspace", ["TWORK"], ["CTEAM", "twork"]],
    ] as const) {
      for (const id of bad) {
        await expect(AgentGrants.create({ ...base, subjectKind: kind, subjectId: id })).rejects.toThrow(new RegExp(`a ${kind} subject_id must be a Slack`));
      }
      for (const id of ok) await AgentGrants.revoke((await AgentGrants.create({ ...base, subjectKind: kind, subjectId: id })).id);
    }
    // A DM is not a channel subject: a user member grant with dm_only covers it.
    await expect(AgentGrants.create({ ...base, subjectKind: "channel", subjectId: "DDIRECT" })).rejects.toThrow(
      /not a DM .*user member grant with dm_only/,
    );
    for (const kind of ["channel", "workspace"] as const) {
      await expect(AgentGrants.create({ ...base, subjectKind: kind, subjectId: "CTEAM", role: "manager" })).rejects.toThrow(/only be granted member/);
      await expect(AgentGrants.create({ ...base, subjectKind: kind, subjectId: "CTEAM", role: "approver" })).rejects.toThrow(/only be granted member/);
      await expect(AgentGrants.create({ ...base, subjectKind: kind, subjectId: "CTEAM", deny: true })).rejects.toThrow(/deny applies to user/);
      await expect(AgentGrants.create({ ...base, subjectKind: kind, subjectId: "CTEAM", dmOnly: true })).rejects.toThrow(/dm_only applies to user/);
    }
    // Allowed combinations.
    await AgentGrants.create({ ...base, subjectKind: "channel", subjectId: "CTEAM" });
    await AgentGrants.create({ ...base, subjectKind: "workspace", subjectId: "TWORK" });
    await AgentGrants.create({ ...base, role: "manager", deny: true });
    await AgentGrants.create({ ...base, role: "approver" });
    await AgentGrants.create({ ...base, dmOnly: true });
    expect((await AgentGrants.listAll()).length).toBe(5);
    await db.run("DELETE FROM agent_grants");
    expect(await AgentGrants.listAll()).toEqual([]);
  });

  test("a non-Slack subject is refused until the access flip, whatever the kind", async () => {
    for (const subjectId of ["email:a@example.com", "a@example.com", "user:abc123", "slack:user:UALICE", "whatsapp:phone:+628123456789"]) {
      await expect(AgentGrants.create({ ...base, subjectId })).rejects.toThrow(/not supported until the access flip/);
    }
    await expect(AgentGrants.create({ ...base, subjectKind: "channel", subjectId: "boundary:abc" })).rejects.toThrow(/not supported until the access flip/);
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

describe("grants carry a subject reference (Slack only)", () => {
  const stored = async (id: string) => db.one<{ subject_ref: string | null; subject_user_id: string | null; subject_kind: string; subject_id: string }>(
    "SELECT subject_ref, subject_user_id, subject_kind, subject_id FROM agent_grants WHERE id = ?", [id]);

  test("a bare subject id stores the short typed form and no user", async () => {
    const g = await AgentGrants.create({ ...base, subjectId: "UALICE" });
    expect(await stored(g.id)).toMatchObject({ subject_ref: "slack:user:UALICE", subject_user_id: null, subject_kind: "user", subject_id: "UALICE" });
    expect(g.subjectRef).toBe("slack:user:UALICE");
  });

  test("a typed reference sets kind, id and ref, and the user when the binding exists", async () => {
    await Domain._wipeForTests();
    const b = await Domain.ensureBinding({ service: "slack", kind: "user", workspace: "T0EXAMPLE", value: "U0EXAMPLE", state: "observed", source: "test" });
    const g = await AgentGrants.create({ persona: "scout", role: "member", createdBy: "UMGR", subject: "slack:user:T0EXAMPLE/U0EXAMPLE" });
    expect(g).toMatchObject({ subjectKind: "user", subjectId: "U0EXAMPLE", subjectRef: "slack:user:T0EXAMPLE/U0EXAMPLE", subjectUserId: b.userId });
    expect(await stored(g.id)).toMatchObject({ subject_user_id: b.userId });
    expect((await AgentGrants.listForPersona("scout"))[0]).toMatchObject({ subjectRef: "slack:user:T0EXAMPLE/U0EXAMPLE", subjectUserId: b.userId });
    await Domain._wipeForTests();
  });

  test("an unseen binding leaves the user empty (the reconciler fills it)", async () => {
    await Domain._wipeForTests();
    const g = await AgentGrants.create({ persona: "scout", role: "member", createdBy: "UMGR", subject: "slack:user:T0EXAMPLE/U0NOBODY" });
    expect(g.subjectUserId).toBeNull();
    expect(g.subjectRef).toBe("slack:user:T0EXAMPLE/U0NOBODY");
  });

  test("a channel reference works for member grants", async () => {
    const g = await AgentGrants.create({ persona: "scout", role: "member", createdBy: "UMGR", subject: "slack:channel:C0TEAM" });
    expect(g).toMatchObject({ subjectKind: "channel", subjectId: "C0TEAM", subjectRef: "slack:channel:C0TEAM", subjectUserId: null });
  });

  test("a workspace subject has no reference", async () => {
    const g = await AgentGrants.create({ ...base, subjectKind: "workspace", subjectId: "T0EXAMPLE" });
    expect(g.subjectRef).toBeNull();
  });

  test("a subject that disagrees with the kind or id is refused", async () => {
    await expect(AgentGrants.create({ ...base, subject: "slack:user:U0EXAMPLE", subjectId: "U0OTHER" })).rejects.toThrow(/does not match/);
    await expect(AgentGrants.create({ ...base, subjectKind: "channel", subject: "slack:user:U0EXAMPLE" })).rejects.toThrow(/does not match/);
  });

  test("email, user, phone and malformed references are refused until the access flip", async () => {
    for (const subject of ["email:a@example.com", "user:abc123", "whatsapp:phone:+628123456789", "telegram:user:12345"]) {
      await expect(AgentGrants.create({ persona: "scout", role: "member", createdBy: "UMGR", subject })).rejects.toThrow(/not supported until the access flip/);
    }
    await expect(AgentGrants.create({ persona: "scout", role: "member", createdBy: "UMGR", subject: "slack:user:not valid" })).rejects.toThrow(/not a valid reference/);
    await expect(AgentGrants.create({ persona: "scout", role: "member", createdBy: "UMGR" })).rejects.toThrow(/subject/);
  });
});
