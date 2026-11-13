import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as Domain from "../../src/db/domain";
import { type DbClient, openDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";

const WS = "T0EXAMPLE";
const slack = (value: string, over: Partial<Parameters<typeof Domain.ensureBinding>[0]> = {}) => ({
  service: "slack",
  kind: "user",
  workspace: WS,
  value,
  state: "observed" as const,
  source: "test",
  ...over,
});
const email = (value: string, over: Partial<Parameters<typeof Domain.ensureBinding>[0]> = {}) => ({
  service: "email",
  kind: "address",
  workspace: "",
  value,
  state: "observed" as const,
  source: "test",
  ...over,
});

for (const dialect of ["sqlite", "pg"] as const) {
  describe(`domain repo (${dialect})`, () => {
    let db: DbClient;
    beforeAll(async () => {
      db = dialect === "sqlite" ? await openDb({ dialect: "sqlite", path: ":memory:" }) : await openDb({ dialect: "pg", driver: "pglite" });
      if (dialect === "pg") await runMigrations(db, { log: () => {} });
    });
    afterAll(async () => {
      await db.close();
    });
    beforeEach(async () => {
      for (const t of ["user_aliases", "bindings", "boundaries", "users"]) await db.run(`DELETE FROM ${t}`);
    });
    const count = async (t: string) => Number((await db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`))!.n);

    test("ensureUser creates a user with defaults", async () => {
      const u = await Domain.ensureUser({ displayName: "Jane Doe" }, db);
      expect(u.kind).toBe("person");
      expect(u.display_name).toBe("Jane Doe");
      expect(await count("users")).toBe(1);
    });

    test("ensureBinding creates a user and binding once, then is idempotent", async () => {
      const a = await Domain.ensureBinding(slack("U0EXAMPLE"), db);
      expect(a.created).toBe(true);
      expect(a.binding.state).toBe("observed");
      expect(a.userId).toBe(a.binding.user_id);
      const b = await Domain.ensureBinding(slack("U0EXAMPLE"), db);
      expect(b.created).toBe(false);
      expect(b.userId).toBe(a.userId);
      expect(b.binding.id).toBe(a.binding.id);
      expect(await count("users")).toBe(1);
      expect(await count("bindings")).toBe(1);
    });

    test("ensureBinding attaches to a given user and creates no extra user", async () => {
      const u = await Domain.ensureUser({}, db);
      const a = await Domain.ensureBinding(email("a@example.com", { userId: u.id }), db);
      expect(a.userId).toBe(u.id);
      expect(await count("users")).toBe(1);
    });

    test("state upgrades but never downgrades", async () => {
      const a = await Domain.ensureBinding(slack("U0EXAMPLE", { state: "declared" }), db);
      expect(a.binding.state).toBe("declared");
      const up = await Domain.ensureBinding(slack("U0EXAMPLE", { state: "observed" }), db);
      expect(up.binding.state).toBe("observed");
      const v = await Domain.ensureBinding(slack("U0EXAMPLE", { state: "verified" }), db);
      expect(v.binding.state).toBe("verified");
      expect(v.binding.verified_at).not.toBeNull();
      const down = await Domain.ensureBinding(slack("U0EXAMPLE", { state: "declared" }), db);
      expect(down.binding.state).toBe("verified");
      const down2 = await Domain.ensureBinding(slack("U0EXAMPLE", { state: "observed" }), db);
      expect(down2.binding.state).toBe("verified");
      expect(down2.created).toBe(false);
    });

    test("boundary state never downgrades either", async () => {
      const a = await Domain.ensureBoundary({ service: "slack", kind: "channel", workspace: WS, value: "C0EXAMPLE", state: "verified" }, db);
      expect(a.created).toBe(true);
      const b = await Domain.ensureBoundary({ service: "slack", kind: "channel", workspace: WS, value: "C0EXAMPLE", state: "declared" }, db);
      expect(b.created).toBe(false);
      expect(b.boundary.state).toBe("verified");
      expect(b.boundary.id).toBe(a.boundary.id);
      expect(await count("boundaries")).toBe(1);
    });

    test("two concurrent ensureBinding calls on one key yield one row and one user", async () => {
      const rs = await Promise.all([Domain.ensureBinding(slack("U0RACE"), db), Domain.ensureBinding(slack("U0RACE"), db)]);
      expect(await count("bindings")).toBe(1);
      expect(await count("users")).toBe(1);
      expect(rs[0].userId).toBe(rs[1].userId);
      expect(rs.filter((r) => r.created).length).toBe(1);
    });

    test("slack without a workspace is refused", async () => {
      await expect(Domain.ensureBinding(slack("U0EXAMPLE", { workspace: "" }), db)).rejects.toThrow(/workspace/);
      await expect(Domain.ensureBoundary({ service: "slack", kind: "channel", workspace: "", value: "C0EXAMPLE", state: "observed" }, db)).rejects.toThrow(/workspace/);
      expect(await count("users")).toBe(0);
    });

    test("findBinding and findBoundary", async () => {
      expect(await Domain.findBinding({ service: "slack", kind: "user", workspace: WS, value: "U0EXAMPLE" }, db)).toBeNull();
      const a = await Domain.ensureBinding(slack("U0EXAMPLE"), db);
      expect((await Domain.findBinding({ service: "slack", kind: "user", workspace: WS, value: "U0EXAMPLE" }, db))?.id).toBe(a.binding.id);
      expect(await Domain.findBoundary({ service: "slack", workspace: WS, value: "C0EXAMPLE" }, db)).toBeNull();
    });

    test("preferredBinding: verified email, else slack", async () => {
      const u = await Domain.ensureUser({}, db);
      expect(await Domain.preferredBinding(u.id, db)).toBeNull();
      await Domain.ensureBinding(slack("U0EXAMPLE", { userId: u.id }), db);
      expect((await Domain.preferredBinding(u.id, db))?.service).toBe("slack");
      await Domain.ensureBinding(email("a@example.com", { userId: u.id, state: "observed" }), db);
      expect((await Domain.preferredBinding(u.id, db))?.service).toBe("slack");
      await Domain.ensureBinding(email("a@example.com", { userId: u.id, state: "verified" }), db);
      const p = await Domain.preferredBinding(u.id, db);
      expect(p?.service).toBe("email");
      expect(p?.value).toBe("a@example.com");
    });

    test("adopt moves an unverified holder's bindings and writes an alias", async () => {
      const old = await Domain.ensureBinding(slack("U0EXAMPLE"), db);
      await Domain.ensureBinding(slack("U0SECOND", { userId: old.userId, state: "declared" }), db);
      const target = await Domain.ensureUser({}, db);
      const r = await Domain.adoptBinding({ service: "slack", kind: "user", workspace: WS, value: "U0EXAMPLE", toUserId: target.id, state: "verified" }, db);
      expect(r.conflict).toBeUndefined();
      expect(r.adopted).toBe(true);
      expect(r.movedBindingIds.length).toBe(2);
      const moved = await db.query<{ user_id: string }>("SELECT user_id FROM bindings");
      expect(moved.every((m) => m.user_id === target.id)).toBe(true);
      const bound = await Domain.findBinding({ service: "slack", kind: "user", workspace: WS, value: "U0EXAMPLE" }, db);
      expect(bound?.state).toBe("verified");
      const alias = await db.one<{ user_id: string }>("SELECT user_id FROM user_aliases WHERE old_id = ?", [old.userId]);
      expect(alias?.user_id).toBe(target.id);
      expect(await Domain.resolveUserId(old.userId, db)).toBe(target.id);
    });

    test("adopt of an unheld value creates it verified under the target", async () => {
      const target = await Domain.ensureUser({}, db);
      const r = await Domain.adoptBinding({ service: "slack", kind: "user", workspace: WS, value: "U0NEW", toUserId: target.id, state: "verified" }, db);
      expect(r.adopted).toBe(false);
      expect(r.conflict).toBeUndefined();
      expect(r.binding?.user_id).toBe(target.id);
      expect(r.binding?.state).toBe("verified");
    });

    test("adopt of a value the target already holds only upgrades it", async () => {
      const a = await Domain.ensureBinding(slack("U0EXAMPLE"), db);
      const r = await Domain.adoptBinding({ service: "slack", kind: "user", workspace: WS, value: "U0EXAMPLE", toUserId: a.userId, state: "verified" }, db);
      expect(r.adopted).toBe(false);
      expect(r.binding?.state).toBe("verified");
      expect(await count("user_aliases")).toBe(0);
    });

    test("adopt refuses to merge when the other user holds a verified binding", async () => {
      const other = await Domain.ensureBinding(slack("U0EXAMPLE"), db);
      await Domain.ensureBinding(email("a@example.com", { userId: other.userId, state: "verified" }), db);
      const target = await Domain.ensureUser({}, db);
      const r = await Domain.adoptBinding({ service: "slack", kind: "user", workspace: WS, value: "U0EXAMPLE", toUserId: target.id, state: "verified" }, db);
      expect(r.conflict).toBe(true);
      expect(r.adopted).toBe(false);
      expect(r.movedBindingIds).toEqual([]);
      expect(await count("user_aliases")).toBe(0);
      expect((await Domain.findBinding({ service: "slack", kind: "user", workspace: WS, value: "U0EXAMPLE" }, db))?.user_id).toBe(other.userId);
    });

    test("adopt refuses when the contested binding itself is verified for another user", async () => {
      const other = await Domain.ensureBinding(slack("U0EXAMPLE", { state: "verified" }), db);
      const target = await Domain.ensureUser({}, db);
      const r = await Domain.adoptBinding({ service: "slack", kind: "user", workspace: WS, value: "U0EXAMPLE", toUserId: target.id, state: "verified" }, db);
      expect(r.conflict).toBe(true);
      expect((await Domain.findBinding({ service: "slack", kind: "user", workspace: WS, value: "U0EXAMPLE" }, db))?.user_id).toBe(other.userId);
    });

    test("alias resolution follows chains and passes unknown ids through as null", async () => {
      const a = await Domain.ensureUser({}, db);
      const b = await Domain.ensureUser({}, db);
      const c = await Domain.ensureUser({}, db);
      await db.run("INSERT INTO user_aliases (old_id, user_id, merged_at) VALUES (?, ?, 1)", ["gone-1", a.id]);
      await db.run("INSERT INTO user_aliases (old_id, user_id, merged_at) VALUES (?, ?, 1)", [a.id + "-x", b.id]);
      expect(await Domain.resolveUserId("gone-1", db)).toBe(a.id);
      expect(await Domain.resolveUserId(c.id, db)).toBe(c.id);
      expect(await Domain.resolveUserId("nobody", db)).toBeNull();
    });

    test("a failed transaction leaves no half-created user", async () => {
      await expect(
        db.transaction(async (tx) => {
          await Domain.ensureBinding(slack("U0EXAMPLE"), tx);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await count("users")).toBe(0);
      expect(await count("bindings")).toBe(0);
    });
  });
}
