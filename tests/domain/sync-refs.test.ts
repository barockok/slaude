import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as Domain from "../../src/db/domain";
import { type DbClient, openDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import { collectRefs, ensureRefs, planRefs, RefRefusal, safeRef, type RefUse } from "../../src/domain/sync-refs";
import { parseRef } from "../../src/refs/parse";
import { SoulDataSchema } from "../../src/soul/data";

const WS = "T0EXAMPLE";
const use = (field: string, text: string, persona = "ana"): RefUse => {
  const r = parseRef(text);
  if (!r.ok) throw new Error(r.reason);
  return { persona, field, ref: r.ref };
};

describe("collectRefs", () => {
  test("reads manager, approvers, lists, channel overrides and proactive channels", () => {
    const soul = SoulDataSchema.parse({
      manager: { userId: "U0EXAMPLE" },
      backupManager: { userId: "U1EXAMPLE" },
      approvers: [{ userId: "U2EXAMPLE", scope: "anything", catchall: true }],
      allowedChannels: ["C0EXAMPLE"],
      trustedChannels: ["C1EXAMPLE"],
      blockedUsers: ["U3EXAMPLE"],
      dmAllowedUsers: ["U4EXAMPLE"],
      channelOverrides: [{ channel: "C2EXAMPLE", approvers: [{ userId: "U5EXAMPLE", scope: "anything", catchall: true }] }],
    });
    const uses = collectRefs("ana", soul, "## Proactive\n- Enabled: yes\n- Read: <#C3EXAMPLE>\n");
    const ids = uses.map((u) => (u.ref.kind === "external" ? u.ref.id : "")).sort();
    expect(ids).toEqual(["C0EXAMPLE", "C1EXAMPLE", "C2EXAMPLE", "C3EXAMPLE", "U0EXAMPLE", "U1EXAMPLE", "U2EXAMPLE", "U3EXAMPLE", "U4EXAMPLE", "U5EXAMPLE"]);
    expect(uses.every((u) => u.persona === "ana" && u.field.length > 0)).toBe(true);
  });
});

describe("safeRef", () => {
  test("slack as written, email and phone masked", () => {
    expect(safeRef(use("f", "slack:user:U0EXAMPLE").ref, WS)).toBe("slack:user:T0EXAMPLE/U0EXAMPLE");
    expect(safeRef(use("f", "email:Jane.Doe@Example.com").ref)).toBe("email:***@example.com");
    expect(safeRef(use("f", "whatsapp:phone:+14155550123").ref)).toBe("whatsapp:phone:***0123");
  });
});

for (const dialect of ["sqlite", "pg"] as const) {
  describe(`planRefs and ensureRefs (${dialect})`, () => {
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

    test("short Slack refs need exactly one workspace, naming persona and field", async () => {
      const u = [use("access.manager", "slack:user:U0EXAMPLE")];
      await expect(planRefs(u, [], db)).rejects.toThrow(/persona 'ana': access\.manager .*no Slack workspace/);
      await expect(planRefs(u, [WS, "T1EXAMPLE"], db)).rejects.toThrow(/2 Slack workspaces/);
      expect((await planRefs(u, [WS], db)).map((r) => r.ref)).toEqual(["slack:user:T0EXAMPLE/U0EXAMPLE"]);
      // A reference that names its workspace needs no default.
      expect(await planRefs([use("f", "slack:user:T9EXAMPLE/U0EXAMPLE")], [], db)).toHaveLength(1);
    });

    test("creates declared users, bindings and boundaries for every scheme; selectors and agent refs create nothing", async () => {
      const uses = [
        use("a", "slack:user:U0EXAMPLE"),
        use("b", "slack:channel:C0EXAMPLE"),
        use("c", "email:jane@example.com"),
        use("d", "whatsapp:phone:+14155550123"),
        use("e", "telegram:user:123456"),
        use("f", "whatsapp:group:120363@g.us"),
        use("g", "trust:public"),
        use("h", "agent:sam"),
        use("i", "slack:user:U0EXAMPLE", "bob"),
      ];
      const r = await ensureRefs(uses, [WS], db);
      expect(r.created.map((x) => x.type).sort()).toEqual(["boundary", "boundary", "user", "user", "user", "user"]);
      expect(r.created.find((x) => x.ref.includes("U0EXAMPLE"))!.personas).toEqual(["ana", "bob"]);
      expect(r.created.every((x) => x.state === "declared" && x.id)).toBe(true);
      expect(JSON.stringify(r.created)).not.toContain("jane@");
      const mail = await Domain.findBinding({ service: "email", kind: "address", workspace: "", value: "jane@example.com" }, db);
      expect(mail?.state).toBe("declared");
      expect((await Domain.findBoundary({ service: "slack", workspace: WS, value: "C0EXAMPLE" }, db))?.state).toBe("declared");
      expect(r.events.map((e) => e.action)).toContain("binding.created");
      // A rerun creates nothing and plans nothing.
      expect((await ensureRefs(uses, [WS], db)).created).toEqual([]);
      expect(await planRefs(uses, [WS], db)).toEqual([]);
    });

    test("existing verified state is not downgraded", async () => {
      const key = { service: "slack", kind: "user", workspace: WS, value: "U0EXAMPLE" };
      await Domain.ensureBinding({ ...key, state: "verified", source: "test" }, db);
      const bk = { service: "slack", workspace: WS, value: "C0EXAMPLE" };
      await Domain.ensureBoundary({ ...bk, kind: "channel", state: "observed" }, db);
      const r = await ensureRefs([use("a", "slack:user:U0EXAMPLE"), use("b", "slack:channel:C0EXAMPLE")], [WS], db);
      expect(r.created).toEqual([]);
      expect((await Domain.findBinding(key, db))?.state).toBe("verified");
      expect((await Domain.findBoundary(bk, db))?.state).toBe("observed");
    });

    test("an internal reference must already exist", async () => {
      await expect(planRefs([use("x", "user:missing")], [WS], db)).rejects.toBeInstanceOf(RefRefusal);
      await expect(ensureRefs([use("x", "boundary:missing")], [WS], db)).rejects.toThrow(/persona 'ana': x names an internal record that does not exist/);
      const u = await Domain.ensureUser({}, db);
      expect(await planRefs([use("x", `user:${u.id}`)], [WS], db)).toEqual([]);
      expect((await ensureRefs([use("x", `user:${u.id}`)], [WS], db)).created).toEqual([]);
    });
  });
}
