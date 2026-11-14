import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as Domain from "../../src/db/domain";
import { type DbClient, openDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import { normaliseEmail } from "../../src/db/account-projection";
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

    test("expired link token rows are purged, live ones kept, and a dry run purges nothing", async () => {
      const now = Date.now();
      await db.run("INSERT INTO link_token_uses (jti, team_id, slack_user_id, used_at, expires_at) VALUES ('dead', 'T0EXAMPLE', 'U0EXAMPLE', 1, ?)", [now - 1000]);
      await db.run("INSERT INTO link_token_uses (jti, team_id, slack_user_id, used_at, expires_at) VALUES ('live', 'T0EXAMPLE', 'U0EXAMPLE', 1, ?)", [now + 600_000]);
      const dry = await reconcile(opts({ dryRun: true }));
      expect(dry.linkTokensPurged).toBe(1);
      expect(await count("link_token_uses")).toBe(2);
      const r = await reconcile(opts());
      expect(r.linkTokensPurged).toBe(1);
      expect(await count("link_token_uses")).toBe(1);
      expect((await reconcile(opts())).linkTokensPurged).toBe(0);
    });

    describe("unproven email bindings (D16)", () => {
      const ISS2 = "https://idp2.example.com";
      const mailKey = (v: string) => ({ service: "email", kind: "address", workspace: "", value: v });
      /** The rc.18 state: an account, its verified oidc binding and a verified email binding, with no proof recorded. */
      async function legacyLogin(sub: string, email: string, o: { iss?: string; proven?: boolean } = {}) {
        const iss = o.iss ?? ISS;
        const flag = dialect === "pg" ? !!o.proven : o.proven ? 1 : 0;
        await db.run("INSERT INTO accounts (id, issuer, subject, email, email_proven, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)", [`acc-${sub}`, iss, sub, email, flag]);
        const o1 = await Domain.ensureBinding({ service: "oidc", kind: "subject", workspace: iss, value: sub, state: "verified", source: "oidc-login" }, db);
        await Domain.ensureBinding({ ...mailKey(normaliseEmail(email)!), userId: o1.userId, state: "verified", source: "adopt" }, db);
        return o1.userId;
      }
      const state = async (v: string) => (await fb(mailKey(v)))?.state;
      const demoteOpts = (o: ReconcileOptions = {}) => opts({ demoteUnprovenEmails: true, ...o });

      test("the report counts verified email bindings no proving login backs, per issuer, with no address in it", async () => {
        await legacyLogin("a", "a@example.com");
        await legacyLogin("b", "b@example.com");
        await legacyLogin("c", "c@example.com", { iss: ISS2 });
        await legacyLogin("p", "p@example.com", { proven: true });
        const r = await reconcile(opts());
        expect(r.unprovenEmails).toEqual({ total: 3, byIssuer: { [ISS]: 2, [ISS2]: 1 }, demoted: 0 });
        expect(JSON.stringify(r)).not.toContain("a@example.com");
        const text = formatReconcileReport(r);
        expect(text).toContain("unproven email bindings: 3");
        expect(text).toContain(`${ISS} 2`);
        expect(text).not.toContain("@example.com");
      });

      test("a plain run, a dry run and a run without --apply never change a state", async () => {
        await legacyLogin("a", "a@example.com");
        await reconcile(opts());
        await reconcile(opts({ dryRun: true, demoteUnprovenEmails: true }));
        await reconcile(opts({ demoteUnprovenEmails: false }));
        expect(await state("a@example.com")).toBe("verified");
      });

      test("the demote option demotes to observed, only unproven ones, and nothing else", async () => {
        const ua = await legacyLogin("a", "a@example.com");
        await legacyLogin("p", "p@example.com", { proven: true });
        const slackB = await Domain.ensureBinding({ ...slack("U0EXAMPLE"), userId: ua, state: "verified", source: "link" }, db);
        const r = await reconcile(demoteOpts());
        expect(r.unprovenEmails).toEqual({ total: 1, byIssuer: { [ISS]: 1 }, demoted: 1 });
        const a = await fb(mailKey("a@example.com"));
        expect(a?.state).toBe("observed");
        expect(a?.verified_at).toBeNull();
        expect(a?.user_id).toBe(ua);
        expect(await state("p@example.com")).toBe("verified");
        expect((await fb({ service: "oidc", kind: "subject", workspace: ISS, value: "a" }))?.state).toBe("verified");
        expect((await fb(slack("U0EXAMPLE")))?.state).toBe(slackB.binding.state);
        expect((await fb(slack("U0EXAMPLE")))?.state).toBe("verified");
      });

      test("a rerun finds nothing, and the next login with proof is not undone by it", async () => {
        await legacyLogin("a", "a@example.com");
        await reconcile(demoteOpts());
        const again = await reconcile(demoteOpts());
        expect(again.unprovenEmails).toEqual({ total: 0, byIssuer: {}, demoted: 0 });
        // a proven login is modelled by flagging the account and raising the binding, as projectLogin does
        await db.run("UPDATE accounts SET email_proven = ? WHERE subject = 'a'", [dialect === "pg" ? true : 1]);
        await db.run("UPDATE bindings SET state = 'verified' WHERE value = 'a@example.com'");
        expect((await reconcile(demoteOpts())).unprovenEmails.total).toBe(0);
        expect(await state("a@example.com")).toBe("verified");
      });

      test("a verified email binding with no account behind it, or another account's address, is unproven", async () => {
        const orphan = await Domain.ensureBinding({ ...mailKey("orphan@example.com"), state: "verified", source: "adopt" }, db);
        const other = await legacyLogin("p", "p@example.com", { proven: true });
        await Domain.ensureBinding({ ...mailKey("moved@example.com"), userId: other, state: "verified", source: "adopt" }, db);
        const r = await reconcile(demoteOpts());
        expect(r.unprovenEmails.total).toBe(2);
        expect(r.unprovenEmails.byIssuer["(no account)"]).toBe(1);
        expect(r.unprovenEmails.byIssuer[ISS]).toBe(1);
        expect(await state("orphan@example.com")).toBe("observed");
        expect(await state("moved@example.com")).toBe("observed");
        expect(await state("p@example.com")).toBe("verified");
        void orphan;
      });

      test("an address that differs only by case or domain folding still matches the proving account", async () => {
        const u = await legacyLogin("p", "Mixed.Case@Example.com", { proven: true });
        void u;
        const r = await reconcile(opts());
        expect(r.unprovenEmails.total).toBe(0);
      });

      test("demotion writes one audit event with counts only", async () => {
        await legacyLogin("a", "a@example.com");
        await reconcile(demoteOpts());
        const e = events.find((x) => x.action === "domain.emails_demoted");
        expect(e).toBeDefined();
        expect(JSON.stringify(e)).not.toContain("example.com/");
        expect(JSON.stringify(e)).not.toContain("a@example.com");
        expect(e!.details).toMatchObject({ demoted: 1, byIssuer: { [ISS]: 1 } });
      });

      test("the boot hook only reports: it never asks for demotion", async () => {
        await legacyLogin("a", "a@example.com");
        let seen: ReconcileOptions | undefined;
        await reconcileAtBoot({
          role: "mono",
          liveTeamIds: () => [WS],
          log: () => {},
          run: async (o) => ((seen = o), reconcile({ ...opts(), ...o, db })),
        });
        expect(seen?.demoteUnprovenEmails).toBeUndefined();
        expect(await state("a@example.com")).toBe("verified");
      });
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
      expect(txs).toBeLessThanOrEqual(11); // plus a transaction per page of grants filled with their ref and user
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

    describe("grant subjects, lock teams and the workspace report (slice C task 11)", () => {
      const pgv = (b: boolean) => (dialect === "pg" ? b : b ? 1 : 0);
      async function stored(id: string, kind: string, sid: string, o: { ref?: string | null; uid?: string | null; tenant?: string } = {}) {
        const cols = ["id", "persona", "subject_kind", "subject_id", "role", "deny", "dm_only", "created_by", "created_at", "subject_ref", "subject_user_id"];
        const vals: unknown[] = [id, "sam", kind, sid, "member", pgv(false), pgv(false), "test", 1, o.ref ?? null, o.uid ?? null];
        if (dialect === "pg") (cols.push("tenant_id"), vals.push(o.tenant ?? "default"));
        await db.run(`INSERT INTO agent_grants (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, vals);
      }
      async function lockRow(ch: string, ts: string, team: string | null) {
        await db.run("INSERT INTO one_on_one_locks (channel_id, thread_ts, locked_user, created_by, created_at, team_id) VALUES (?, ?, ?, ?, ?, ?)", [ch, ts, "U0EXAMPLE", "U0EXAMPLE", 1, team]);
      }
      const grantRow = (id: string) => db.one<{ subject_ref: string | null; subject_user_id: string | null }>("SELECT subject_ref, subject_user_id FROM agent_grants WHERE id = ?", [id]);
      beforeEach(async () => {
        await db.run("DELETE FROM one_on_one_locks");
      });

      test("fills the ref and the user for Slack grants in the single workspace", async () => {
        await stored("gr-u", "user", "U0EXAMPLE");
        await stored("gr-c", "channel", "C0EXAMPLE");
        const r = await reconcile(opts());
        const u = await grantRow("gr-u");
        expect(u!.subject_ref).toBe(`slack:user:${WS}/U0EXAMPLE`);
        const b = await fb({ service: "slack", kind: "user", workspace: WS, value: "U0EXAMPLE" });
        expect(u!.subject_user_id).toBe(b!.user_id);
        expect((await grantRow("gr-c"))!.subject_ref).toBe(`slack:channel:${WS}/C0EXAMPLE`);
        expect((await grantRow("gr-c"))!.subject_user_id).toBeNull();
        expect(r.grantSubjects.created).toBe(2);
      });

      test("a second run changes nothing and writes no audit", async () => {
        await stored("gr-u", "user", "U0EXAMPLE");
        await reconcile(opts());
        events.length = 0;
        const r = await reconcile(opts());
        expect(r.grantSubjects.created).toBe(0);
        expect(r.lockTeams.created).toBe(0);
        expect(events).toEqual([]);
      });

      test("a dry run reports and writes nothing", async () => {
        await stored("gr-u", "user", "U0EXAMPLE");
        await lockRow("C0EXAMPLE", "1.1", null);
        const r = await reconcile(opts({ dryRun: true }));
        expect(r.grantSubjects.created).toBe(1);
        expect(r.lockTeams.created).toBe(1);
        expect((await grantRow("gr-u"))!.subject_ref).toBeNull();
        expect((await db.one<{ team_id: string | null }>("SELECT team_id FROM one_on_one_locks"))!.team_id).toBeNull();
      });

      test("never overwrites a value already stored", async () => {
        await stored("gr-keep", "user", "U0EXAMPLE", { ref: `slack:user:${WS2}/U0EXAMPLE`, uid: "keep-user" });
        await reconcile(opts());
        const g = await grantRow("gr-keep");
        expect(g!.subject_ref).toBe(`slack:user:${WS2}/U0EXAMPLE`);
        expect(g!.subject_user_id).toBe("keep-user");
      });

      test("a ref with no user yet is filled, and the user follows once the binding exists", async () => {
        await stored("gr-u", "user", "U0EXAMPLE", { ref: `slack:user:${WS}/U0EXAMPLE` });
        // The grant-user source creates the declared binding in the same run, so the user is filled.
        await reconcile(opts());
        expect((await grantRow("gr-u"))!.subject_user_id).not.toBeNull();
      });

      test("ambiguous and missing workspaces are skipped and counted, nothing written", async () => {
        await stored("gr-u", "user", "U0EXAMPLE");
        await lockRow("C0EXAMPLE", "1.1", null);
        if (dialect === "pg") await db.run("INSERT INTO slack_apps (api_app_id, team_id, tenant_id, bot_token, signing_secret, created_at, updated_at) VALUES ('A1', ?, 'default', 'x', 'y', 1, 1)", [WS2]);
        const r = await reconcile(opts({ liveTeamIds: () => [WS, WS2] }));
        expect(r.grantSubjects.skipped.ambiguous).toBe(1);
        expect(r.lockTeams.skipped.ambiguous).toBe(1);
        expect((await grantRow("gr-u"))!.subject_ref).toBeNull();
        const none = await reconcile(opts({ liveTeamIds: () => [] }));
        if (dialect === "sqlite") {
          expect(none.grantSubjects.skipped.no_workspace).toBe(1);
          expect(none.lockTeams.skipped.no_workspace).toBe(1);
        }
      });

      test("a bot, USLACKBOT, a grid id and a malformed id are skipped; no user is created for them", async () => {
        await stored("gr-bot", "user", "USLACKBOT");
        await stored("gr-grid", "user", "W0EXAMPLE");
        await stored("gr-bad", "user", "lowercase");
        const r = await reconcile(opts());
        expect(r.grantSubjects.skipped.bot).toBe(1);
        expect(r.grantSubjects.skipped.grid).toBe(1);
        expect(r.grantSubjects.skipped.not_slack_id).toBe(1);
        expect((await grantRow("gr-bot"))!.subject_ref).toBeNull();
        // The task 11 pass itself writes no user; the slice B grant-user step already records a declared binding for the id.
        expect((await grantRow("gr-bot"))!.subject_user_id).toBeNull();
      });

      test("pages: more rows than one page are all filled", async () => {
        for (let i = 0; i < 7; i++) await stored(`gr-p${i}`, "channel", `C0PAGE${i}`);
        for (let i = 0; i < 5; i++) await lockRow(`C0LOCK${i}`, "1.1", null);
        const r = await reconcile(opts({ pageSize: 2 }));
        expect(r.grantSubjects.created).toBeGreaterThanOrEqual(7);
        expect(r.lockTeams.created).toBe(5);
        expect(Number((await db.one<{ n: number }>("SELECT COUNT(*) AS n FROM agent_grants WHERE subject_ref IS NULL"))!.n)).toBe(0);
        expect(Number((await db.one<{ n: number }>("SELECT COUNT(*) AS n FROM one_on_one_locks WHERE team_id IS NULL"))!.n)).toBe(0);
      });

      test("lock teams: only NULL rows are filled, a set team stays", async () => {
        await lockRow("C0EXAMPLE", "1.1", null);
        await lockRow("C0EXAMPLE", "2.2", WS2);
        await reconcile(opts());
        const rows = await db.query<{ thread_ts: string; team_id: string }>("SELECT thread_ts, team_id FROM one_on_one_locks ORDER BY thread_ts");
        expect(rows.map((x) => x.team_id)).toEqual([WS, WS2]);
      });

      test("the workspace report lists grants naming an unconnected team, ids only", async () => {
        await stored("gr-ok", "workspace", WS);
        await stored("gr-other", "workspace", "T9OTHER");
        const r = await reconcile(opts({ dryRun: true }));
        expect(r.workspaceGrants).toEqual({ total: 2, mismatched: 1, rows: [{ grantId: "gr-other", teamId: "T9OTHER" }], unjudged: 0 });
        const text = formatReconcileReport(r);
        expect(text).toContain("grant=gr-other team=T9OTHER");
        expect(text).toContain("workspace grants: 1 of 2");
      });

      test("the workspace report changes nothing, even on a real run", async () => {
        await stored("gr-other", "workspace", "T9OTHER");
        const r = await reconcile(opts());
        expect(r.workspaceGrants.mismatched).toBe(1);
        expect(await count("agent_grants")).toBe(1);
        expect(events.filter((e) => e.action === "domain.reconciled")).toEqual([]);
      });

      test("a tenant with no known workspace is not judged", async () => {
        await stored("gr-other", "workspace", "T9OTHER");
        const r = await reconcile(opts({ liveTeamIds: () => [] }));
        if (dialect === "sqlite") expect(r.workspaceGrants).toEqual({ total: 1, mismatched: 0, rows: [], unjudged: 1 });
      });

      test("a summary audit is written when rows were filled, never one per row", async () => {
        await stored("gr-a", "channel", "C0AAA");
        await stored("gr-b", "channel", "C0BBB");
        await reconcile(opts());
        const sums = events.filter((e) => e.action === "domain.reconciled");
        expect(sums.length).toBe(1);
        expect(events.length).toBe(1);
      });
    });
  });
}

describe("reconcileAtBoot", () => {
  test("a no-op run logs one line", async () => {
    const lines: string[] = [];
    const empty = { created: 0, existing: 0, skipped: {} };
    const report = { dryRun: false, conflicts: [], linkTokensPurged: 0, grantSubjects: empty, lockTeams: empty, workspaceGrants: { total: 0, mismatched: 0, rows: [], unjudged: 0 }, unprovenEmails: { total: 0, byIssuer: {}, demoted: 0 }, startedAt: 0, finishedAt: 0, sources: { accounts: empty, slackIdentities: empty, grantUsers: empty, grantChannels: empty, sessionChannels: empty, auditActors: empty } };
    await reconcileAtBoot({ role: "mono", liveTeamIds: () => [], run: async () => report, log: (m) => lines.push(m) });
    expect(lines).toEqual(["reconcile: nothing to do"]);
  });
  test("unproven email bindings are reported at boot, never acted on", async () => {
    const lines: string[] = [];
    const empty = { created: 0, existing: 0, skipped: {} };
    const report = { dryRun: false, conflicts: [], linkTokensPurged: 0, grantSubjects: empty, lockTeams: empty, workspaceGrants: { total: 0, mismatched: 0, rows: [], unjudged: 0 }, unprovenEmails: { total: 2, byIssuer: { "https://idp.example.com": 2 }, demoted: 0 }, startedAt: 0, finishedAt: 0, sources: { accounts: empty, slackIdentities: empty, grantUsers: empty, grantChannels: empty, sessionChannels: empty, auditActors: empty } };
    await reconcileAtBoot({ role: "mono", liveTeamIds: () => [], run: async () => report, log: (m) => lines.push(m) });
    expect(lines.join("\n")).toContain("2 verified email binding(s) have no proof");
    expect(lines.join("\n")).toContain("--demote-unproven-emails --apply");
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
