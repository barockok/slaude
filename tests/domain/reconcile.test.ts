import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as Domain from "../../src/db/domain";
import { type DbClient, openDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import { formatReconcileReport, reconcile, reconcileAtBoot, totalCreated, type ReconcileOptions } from "../../src/domain/reconcile";
import type { AuditInput } from "../../src/audit/index";

const ISS = "https://idp.example.com";
const WS = "T0EXAMPLE";
const WS2 = "T1EXAMPLE";

for (const dialect of ["sqlite", "pg"] as const) {
  describe(`domain reconcile (${dialect})`, () => {
    let db: DbClient;
    let events: AuditInput[];
    beforeAll(async () => {
      db = dialect === "sqlite" ? await openDb({ dialect: "sqlite", path: ":memory:" }) : await openDb({ dialect: "pg", driver: "pglite" });
      if (dialect === "pg") await runMigrations(db, { log: () => {} });
    });
    afterAll(async () => {
      await db.close();
    });
    beforeEach(async () => {
      for (const t of ["user_aliases", "bindings", "boundaries", "users", "slack_identities", "accounts", "agent_grants", "sessions", "audit_events"]) {
        await db.run(`DELETE FROM ${t}`);
      }
      if (dialect === "pg") {
        await db.run("DELETE FROM slack_apps");
        await db.run("DELETE FROM tenants WHERE id <> 'default'");
        await db.run("INSERT INTO slack_apps (api_app_id, team_id, tenant_id, bot_token, signing_secret, created_at, updated_at) VALUES ('A0', ?, 'default', 'x', 'y', 1, 1)", [WS]);
      }
      events = [];
    });
    const opts = (o: ReconcileOptions = {}): ReconcileOptions => ({
      db,
      liveTeamIds: () => [WS],
      audit: async (i) => void events.push(i),
      ...o,
    });
    const fb = (k: Parameters<typeof Domain.findBinding>[0]) => Domain.findBinding(k, db);
    const fbd = (k: Parameters<typeof Domain.findBoundary>[0]) => Domain.findBoundary(k, db);
    const count = async (t: string) => Number((await db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`))!.n);

    let seq = 0;
    async function account(sub: string, email: string, at = 1000 + seq++, proven = true) {
      const flag = dialect === "pg" ? proven : proven ? 1 : 0;
      await db.run("INSERT INTO accounts (id, issuer, subject, email, email_proven, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [`acc-${sub}`, ISS, sub, email, flag, at, at]);
    }
    async function identity(sub: string, team: string, user: string) {
      await db.run("INSERT INTO slack_identities (team_id, slack_user_id, account_id, linked_at, linked_via) VALUES (?, ?, ?, ?, ?)", [team, user, `acc-${sub}`, 1, "test"]);
    }
    async function grant(kind: string, id: string, tenant = "default") {
      const cols = ["id", "persona", "subject_kind", "subject_id", "role", "deny", "dm_only", "created_by", "created_at"];
      const vals: unknown[] = [`g-${seq++}`, "sam", kind, id, "member", dialect === "pg" ? false : 0, dialect === "pg" ? false : 0, "test", 1];
      if (dialect === "pg") (cols.push("tenant_id"), vals.push(tenant));
      await db.run(`INSERT INTO agent_grants (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, vals);
    }
    async function session(team: string | null, channel: string, tenant = "default") {
      const cols = ["id", "created_at", "updated_at", "model", "working_dir", "slack_team_id", "slack_channel_id", "slack_thread_ts"];
      const vals: unknown[] = [`s-${seq++}`, 1, 1, "m", "/w", team, channel, `1.${seq}`];
      if (dialect === "pg") (cols.push("tenant_id"), vals.push(tenant));
      await db.run(`INSERT INTO sessions (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, vals);
    }
    async function actor(id: string, kind = "slack_user", tenant = "default") {
      const cols = ["id", "at", "actor_kind", "actor_id", "action", "summary"];
      const vals: unknown[] = [`e-${seq++}`, 1, kind, id, "x.y", ""];
      if (dialect === "pg") (cols.push("tenant_id"), vals.push(tenant));
      await db.run(`INSERT INTO audit_events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, vals);
    }
    const slack = (v: string, ws = WS) => ({ service: "slack", kind: "user", workspace: ws, value: v });

    async function seed() {
      await account("a", "Alice@Example.com");
      await account("b", "bob@example.com");
      await identity("a", WS, "U0EXAMPLE");
      await grant("user", "U1EXAMPLE");
      await grant("user", "U0EXAMPLE");
      await grant("channel", "C0EXAMPLE");
      await grant("workspace", WS);
      await grant("user", "W0EXAMPLE");
      await session(WS, "C1EXAMPLE");
      await session(null, "D0EXAMPLE");
      await actor("U2EXAMPLE");
      await actor("U1EXAMPLE");
      await actor("W1EXAMPLE");
      await actor("U9EXAMPLE", "agent");
    }

    test("backfills a legacy dataset", async () => {
      await seed();
      const r = await reconcile(opts());
      expect(r.sources.accounts.created).toBe(2);
      expect(r.sources.slackIdentities.created).toBe(1);
      expect(r.sources.grantUsers.created).toBe(1); // U1; U0 is bound by the identity
      expect(r.sources.grantUsers.existing).toBe(1);
      expect(r.sources.grantUsers.skipped.grid).toBe(1);
      expect(r.sources.grantChannels.created).toBe(1);
      expect(r.sources.grantChannels.skipped.workspace_subject).toBe(1);
      expect(r.sources.sessionChannels.created).toBe(2);
      expect(r.sources.auditActors.created).toBe(1); // U2; U1 exists from the grant
      expect(r.sources.auditActors.skipped.grid).toBe(1);
      expect(r.conflicts).toEqual([]);

      const alice = await fb({ service: "oidc", kind: "subject", workspace: ISS, value: "sub-unused" });
      expect(alice).toBeNull();
      const mail = await fb({ service: "email", kind: "address", workspace: "", value: "alice@example.com" });
      expect(mail?.state).toBe("verified");
      const u0 = await fb(slack("U0EXAMPLE"));
      expect(u0?.state).toBe("verified");
      expect(u0?.user_id).toBe(mail!.user_id);
      expect((await fb(slack("U1EXAMPLE")))?.state).toBe("observed"); // raised by the audit actor
      expect((await fb(slack("W0EXAMPLE")))).toBeNull();
      expect((await fbd({ service: "slack", workspace: WS, value: "D0EXAMPLE" }))?.kind).toBe("dm");
      expect((await fbd({ service: "slack", workspace: WS, value: "C0EXAMPLE" }))?.state).toBe("declared");
      expect((await fbd({ service: "slack", workspace: WS, value: "C1EXAMPLE" }))?.state).toBe("observed");
      expect(await db.one("SELECT 1 FROM bindings WHERE value = 'U9EXAMPLE'")).toBeNull(); // agent actor
      expect(await db.one("SELECT 1 FROM bindings WHERE workspace = ''  AND service = 'slack'")).toBeNull();
    });

    test("an account whose login never proved the address gets an observed email binding, and a rerun is a no-op", async () => {
      await account("u", "unproven@example.com", 5000, false);
      const first = await reconcile(opts());
      expect(first.sources.accounts.created).toBe(1);
      const mail = await fb({ service: "email", kind: "address", workspace: "", value: "unproven@example.com" });
      expect(mail?.state).toBe("observed");
      const again = await reconcile(opts());
      expect(again.sources.accounts.created).toBe(0);
      expect(again.sources.accounts.existing).toBe(1);
    });

    test("one summary audit event per run, none in a dry run", async () => {
      await seed();
      await reconcile(opts({ dryRun: true }));
      expect(events).toHaveLength(0);
      await reconcile(opts());
      expect(events).toHaveLength(1);
      expect(events[0]!.action).toBe("domain.reconciled");
      expect(JSON.stringify(events[0])).not.toMatch(/example\.com/);
    });

    test("a no-op run writes no summary event", async () => {
      await reconcile(opts());
      expect(events).toHaveLength(0);
      await seed();
      await reconcile(opts());
      expect(events).toHaveLength(1);
      await reconcile(opts());
      expect(events).toHaveLength(1);
    });

    test("a rerun is a no-op", async () => {
      await seed();
      await reconcile(opts());
      const before = [await count("users"), await count("bindings"), await count("boundaries")];
      const r = await reconcile(opts());
      expect([await count("users"), await count("bindings"), await count("boundaries")]).toEqual(before);
      for (const s of Object.values(r.sources)) expect(s.created).toBe(0);
    });

    test("dry run writes nothing and reports would-create", async () => {
      await seed();
      const r = await reconcile(opts({ dryRun: true }));
      expect(r.dryRun).toBe(true);
      expect(await count("users")).toBe(0);
      expect(await count("bindings")).toBe(0);
      expect(await count("boundaries")).toBe(0);
      const real = await reconcile(opts());
      for (const k of Object.keys(r.sources) as (keyof typeof r.sources)[]) {
        expect(r.sources[k].created).toBe(real.sources[k].created);
        expect(r.sources[k].existing).toBe(real.sources[k].existing);
      }
      expect(formatReconcileReport(r)).toContain("would create");
    });

    test("same normalised email: the oldest keeps it, the other is a conflict, nothing merges", async () => {
      await account("old", "Dup@Example.com", 10);
      await account("new", "dup@example.COM", 20);
      const dry = await reconcile(opts({ dryRun: true }));
      expect(dry.conflicts.map((c) => c.accountId)).toEqual(["acc-new"]);
      const r = await reconcile(opts());
      expect(r.conflicts).toHaveLength(1);
      expect(r.conflicts[0]!.accountId).toBe("acc-new");
      expect(JSON.stringify(r.conflicts)).not.toContain("example");
      expect(await count("users")).toBe(2);
      const mail = await fb({ service: "email", kind: "address", workspace: "", value: "dup@example.com" });
      const oldUser = (await fb({ service: "oidc", kind: "subject", workspace: ISS, value: "old" }))!.user_id;
      expect(mail?.user_id).toBe(oldUser);
      expect(await count("user_aliases")).toBe(0);
      // Rerun: still listed, still no second binding.
      const again = await reconcile(opts());
      expect(again.conflicts).toHaveLength(1);
      expect(await count("bindings")).toBe(3); // 2 oidc + 1 email
    });

    test("ambiguous workspace: grants, audit actors and null-team sessions are skipped and counted", async () => {
      await grant("user", "U1EXAMPLE");
      await grant("channel", "C0EXAMPLE");
      await session(null, "C1EXAMPLE");
      await session(WS2, "C2EXAMPLE"); // explicit team id still lands
      await actor("U2EXAMPLE");
      if (dialect === "pg") await db.run("INSERT INTO slack_apps (api_app_id, team_id, tenant_id, bot_token, signing_secret, created_at, updated_at) VALUES ('A9', ?, 'default', 'x', 'y', 1, 1)", [WS2]);
      const r = await reconcile(opts({ liveTeamIds: () => [WS, WS2] }));
      expect(r.sources.grantUsers.skipped.ambiguous).toBe(1);
      expect(r.sources.grantChannels.skipped.ambiguous).toBe(1);
      expect(r.sources.sessionChannels.skipped.ambiguous).toBe(1);
      expect(r.sources.auditActors.skipped.ambiguous).toBe(1);
      expect(r.sources.sessionChannels.created).toBe(1);
      expect(await db.one("SELECT 1 FROM boundaries WHERE workspace = ''")).toBeNull();
      expect(await count("bindings")).toBe(0);
    });

    test("no resolver on sqlite: unplaceable rows are skipped as no_workspace", async () => {
      if (dialect === "pg") await db.run("DELETE FROM slack_apps");
      await grant("user", "U1EXAMPLE");
      const r = await reconcile(opts({ liveTeamIds: undefined }));
      expect(r.sources.grantUsers.skipped.no_workspace).toBe(1);
      expect(await count("bindings")).toBe(0);
    });

    if (dialect === "pg") {
      test("postgres resolves workspaces per tenant from slack_apps", async () => {
        await db.run("INSERT INTO tenants (id, name, status, created_at) VALUES ('t2', 't2', 'active', 1)");
        const app = (id: string, tenant: string, team: string) =>
          db.run("INSERT INTO slack_apps (api_app_id, team_id, tenant_id, bot_token, signing_secret, created_at, updated_at) VALUES (?, ?, ?, 'x', 'y', 1, 1)", [id, team, tenant]);
        await db.run("DELETE FROM slack_apps");
        await app("A1", "default", WS);
        await app("A2", "t2", WS);
        await app("A3", "t2", WS2);
        await grant("user", "U1EXAMPLE", "default");
        await grant("user", "U2EXAMPLE", "t2");
        await session(null, "C1EXAMPLE", "t2");
        const r = await reconcile(opts({ liveTeamIds: undefined }));
        expect(r.sources.grantUsers.created).toBe(1);
        expect(r.sources.grantUsers.skipped.ambiguous).toBe(1);
        expect(r.sources.sessionChannels.skipped.ambiguous).toBe(1);
        expect((await fb(slack("U1EXAMPLE")))?.state).toBe("declared");
      });
    }

    test("a large backfill is batched: a handful of transactions and queries, and a no-op rerun reads in pages only", async () => {
      {
        for (let i = 0; i < 120; i++) {
          const id = `U${String(i).padStart(5, "0")}BATCH`;
          await actor(id);
          if (i % 2 === 0) await actor(id); // duplicates collapse
          if (i < 70) await grant("user", id);
        }
        for (let i = 0; i < 60; i++) await session(i % 3 === 0 ? null : WS, `C${String(i).padStart(5, "0")}BATCH`);
        await actor("W0GRIDBATCH");
      }
      let stmts = 0;
      let txs = 0;
      const wrap = (c: DbClient): DbClient =>
        new Proxy(c, {
          get(t, k, r) {
            const v = Reflect.get(t, k, r);
            if (k === "transaction") return (fn: (tx: DbClient) => Promise<unknown>) => (txs++, t.transaction((tx) => fn(wrap(tx))));
            if (typeof v === "function" && (k === "run" || k === "one" || k === "query")) return (...a: unknown[]) => (stmts++, (v as (...x: unknown[]) => unknown).apply(t, a));
            return typeof v === "function" ? v.bind(t) : v;
          },
        });
      const first = await reconcile(opts({ db: wrap(db), pageSize: 50 }));
      expect(first.sources.auditActors.created + first.sources.grantUsers.created).toBe(120);
      expect(first.sources.grantUsers.created).toBe(70);
      expect(first.sources.auditActors).toMatchObject({ created: 50, existing: 70, skipped: { grid: 1 } });
      expect(first.sources.sessionChannels.created).toBe(60);
      expect(await count("bindings")).toBe(120);
      expect(await count("boundaries")).toBe(60);
      // A transaction per page of 50 (plus the per-account ones, none here), not one per actor or channel.
      expect(txs).toBeLessThanOrEqual(8);
      stmts = 0;
      txs = 0;
      const again = await reconcile(opts({ db: wrap(db), pageSize: 50 }));
      expect(totalCreated(again)).toBe(0);
      expect(txs).toBe(0);
      expect(stmts).toBeLessThanOrEqual(40);
    }, 60_000);

    test("rolling-deploy repair: an identity and an account with no binding are fixed", async () => {
      await account("a", "alice@example.com");
      await identity("a", WS, "U0EXAMPLE");
      await reconcile(opts());
      // An old replica linked a second identity and logged in a new account, writing no records.
      await account("c", "carol@example.com");
      await identity("c", WS, "U3EXAMPLE");
      expect(await fb(slack("U3EXAMPLE"))).toBeNull();
      const r = await reconcile(opts());
      expect(r.sources.accounts.created).toBe(1);
      expect(r.sources.slackIdentities.created).toBe(1);
      const b = await fb(slack("U3EXAMPLE"));
      expect(b?.state).toBe("verified");
      const o = await fb({ service: "oidc", kind: "subject", workspace: ISS, value: "c" });
      expect(b?.user_id).toBe(o!.user_id);
    });

    test("a slack id seen first as observed is adopted by the account", async () => {
      await actor("U0EXAMPLE");
      await reconcile(opts());
      await account("a", "alice@example.com");
      await identity("a", WS, "U0EXAMPLE");
      const r = await reconcile(opts());
      expect(r.sources.slackIdentities.created).toBe(1);
      expect(await count("user_aliases")).toBe(1);
      expect((await fb(slack("U0EXAMPLE")))?.state).toBe("verified");
    });

    test("two concurrent runs produce no duplicates", async () => {
      await seed();
      await Promise.all([reconcile(opts()), reconcile(opts())]);
      const base = [await count("users"), await count("bindings"), await count("boundaries")];
      const dup = await db.one("SELECT 1 FROM bindings GROUP BY service, kind, workspace, value HAVING COUNT(*) > 1");
      expect(dup).toBeNull();
      await reconcile(opts());
      expect([await count("users"), await count("bindings"), await count("boundaries")]).toEqual(base);
      // Every user holds a binding (no orphan users from a lost race).
      expect(await db.one("SELECT 1 FROM users u WHERE NOT EXISTS (SELECT 1 FROM bindings b WHERE b.user_id = u.id)")).toBeNull();
    });

    test("two unlocked concurrent runs still leave one record per key", async () => {
      if (dialect === "sqlite") return; // one connection, no interleaved transactions
      await seed();
      await Promise.all([reconcile(opts({ unlocked: true })), reconcile(opts({ unlocked: true }))]);
      expect(await db.one("SELECT 1 FROM bindings GROUP BY service, kind, workspace, value HAVING COUNT(*) > 1")).toBeNull();
      expect(await db.one("SELECT 1 FROM users u WHERE NOT EXISTS (SELECT 1 FROM bindings b WHERE b.user_id = u.id)")).toBeNull();
    });
  });
}

describe("reconcileAtBoot", () => {
  test("a no-op run logs one line", async () => {
    const lines: string[] = [];
    const empty = { created: 0, existing: 0, skipped: {} };
    const report = { dryRun: false, conflicts: [], startedAt: 0, finishedAt: 0, sources: { accounts: empty, slackIdentities: empty, grantUsers: empty, grantChannels: empty, sessionChannels: empty, auditActors: empty } };
    await reconcileAtBoot({ role: "mono", liveTeamIds: () => [], run: async () => report, log: (m) => lines.push(m) });
    expect(lines).toEqual(["reconcile: nothing to do"]);
  });
  test("does nothing on a node", async () => {
    let called = false;
    const r = await reconcileAtBoot({ role: "node", liveTeamIds: () => [], run: async () => (called = true, null as never) });
    expect(r).toBeNull();
    expect(called).toBe(false);
  });
  test("a failure is logged and never thrown", async () => {
    const r = await reconcileAtBoot({ role: "mono", liveTeamIds: () => [], run: async () => { throw new Error("boom"); }, log: () => {} });
    expect(r).toBeNull();
  });
});
