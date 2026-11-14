import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Domain from "../../src/db/domain";
import { type DbClient, openDb } from "../../src/db/client";
import { parseRef } from "../../src/refs/parse";
import { resolveRef } from "../../src/refs/resolve";

const WS = "T0EXAMPLE";
const ref = (s: string) => {
  const r = parseRef(s);
  if (!r.ok) throw new Error(r.reason);
  return r.ref;
};

describe("resolveRef", () => {
  let db: DbClient;
  beforeAll(async () => {
    db = await openDb({ dialect: "sqlite", path: ":memory:" });
  });
  afterAll(async () => {
    await db.close();
  });

  test("slack short form uses the default workspace", async () => {
    const a = await Domain.ensureBinding({ service: "slack", kind: "user", workspace: WS, value: "U0EXAMPLE", state: "observed", source: "t" }, db);
    const r = await resolveRef(ref("slack:user:U0EXAMPLE"), { defaultWorkspace: WS, tx: db });
    expect(r.kind).toBe("user");
    expect(r.binding?.id).toBe(a.binding.id);
    expect((r.record as Domain.UserRow).id).toBe(a.userId);
  });

  test("slack short form without a default workspace errors", async () => {
    await expect(resolveRef(ref("slack:user:U0EXAMPLE"), { tx: db })).rejects.toThrow(/workspace/);
    await expect(resolveRef(ref("slack:channel:C0EXAMPLE"), { tx: db })).rejects.toThrow(/workspace/);
  });

  test("an explicit workspace wins over the default", async () => {
    await Domain.ensureBinding({ service: "slack", kind: "user", workspace: "T0OTHER", value: "U0EXAMPLE", state: "observed", source: "t" }, db);
    const r = await resolveRef(ref("slack:user:T0OTHER/U0EXAMPLE"), { defaultWorkspace: WS, tx: db });
    expect(r.binding?.workspace).toBe("T0OTHER");
  });

  test("an unknown slack user resolves to nulls", async () => {
    const r = await resolveRef(ref("slack:user:U0NOBODY"), { defaultWorkspace: WS, tx: db });
    expect(r).toEqual({ kind: "user", record: null, binding: null });
  });

  test("a slack channel resolves to its boundary", async () => {
    const b = await Domain.ensureBoundary({ service: "slack", kind: "channel", workspace: WS, value: "C0EXAMPLE", state: "declared" }, db);
    const r = await resolveRef(ref("slack:channel:C0EXAMPLE"), { defaultWorkspace: WS, tx: db });
    expect(r.kind).toBe("boundary");
    expect((r.record as Domain.BoundaryRow).id).toBe(b.boundary.id);
    expect(r.binding).toBeNull();
  });

  test("email resolves through the normalised address", async () => {
    const a = await Domain.ensureBinding({ service: "email", kind: "address", workspace: "", value: "jane@example.com", state: "declared", source: "t" }, db);
    const r = await resolveRef(ref("email:  Jane@Example.COM "), { tx: db });
    expect(r.kind).toBe("user");
    expect(r.binding?.id).toBe(a.binding.id);
  });

  test("an internal user id resolves through an alias", async () => {
    const target = await Domain.ensureUser({}, db);
    await db.run("INSERT INTO user_aliases (old_id, user_id, merged_at) VALUES (?, ?, 1)", ["old-user", target.id]);
    const r = await resolveRef(ref("user:old-user"), { tx: db });
    expect(r.kind).toBe("user");
    expect((r.record as Domain.UserRow).id).toBe(target.id);
    const direct = await resolveRef(ref(`user:${target.id}`), { tx: db });
    expect((direct.record as Domain.UserRow).id).toBe(target.id);
    expect((await resolveRef(ref("user:nobody"), { tx: db })).record).toBeNull();
  });

  test("an internal boundary resolves by id", async () => {
    const b = await Domain.ensureBoundary({ service: "slack", kind: "channel", workspace: WS, value: "C0EXAMPLE", state: "observed" }, db);
    const r = await resolveRef(ref(`boundary:${b.boundary.id}`), { tx: db });
    expect(r.kind).toBe("boundary");
    expect((r.record as Domain.BoundaryRow).value).toBe("C0EXAMPLE");
  });

  test("whatsapp and telegram resolve to bindings and boundaries", async () => {
    const p = await Domain.ensureBinding({ service: "whatsapp", kind: "phone", workspace: "", value: "+620000000000", state: "declared", source: "t" }, db);
    expect((await resolveRef(ref("whatsapp:phone:+620000000000"), { tx: db })).binding?.id).toBe(p.binding.id);
    const t = await Domain.ensureBinding({ service: "telegram", kind: "user", workspace: "", value: "12345", state: "declared", source: "t" }, db);
    expect((await resolveRef(ref("telegram:user:12345"), { tx: db })).binding?.id).toBe(t.binding.id);
    const g = await Domain.ensureBoundary({ service: "whatsapp", kind: "group", workspace: "", value: "120363000000", state: "declared" }, db);
    expect(((await resolveRef(ref("whatsapp:group:120363000000"), { tx: db })).record as Domain.BoundaryRow).id).toBe(g.boundary.id);
  });

  test("agent, env, node and selector refs are not stored records", async () => {
    expect(await resolveRef(ref("agent:ana"), { tx: db })).toEqual({ kind: "agent", record: null, binding: null });
    expect((await resolveRef(ref("trust:public"), { tx: db })).kind).toBe("selector");
  });
});
