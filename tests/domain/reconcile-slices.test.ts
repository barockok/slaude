/**
 * Slice F, task 6: the reconciler's report of what the person-slice union and the
 * credential pointer depend on. Counts per team and masked names, never an id.
 * Read only, except filling EMPTY credential pointers under `fillPointers`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as Domain from "../../src/db/domain";
import { type DbClient, openDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import { formatReconcileReport, reconcile, reconcileAtBoot, sliceReport, type ReconcileOptions } from "../../src/domain/reconcile";

const ISS = "https://idp.example.com";
const WS = "T0EXAMPLE";
const WS2 = "T1EXAMPLE";

for (const dialect of ["sqlite", "pg"] as const) {
  describe(`reconcile slice report (${dialect})`, () => {
    let db: DbClient;
    beforeAll(async () => {
      db = dialect === "sqlite" ? await openDb({ dialect: "sqlite", path: ":memory:" }) : await openDb({ dialect: "pg", driver: "pglite" });
      if (dialect === "pg") await runMigrations(db, { log: () => {} });
    });
    afterAll(async () => {
      await db.close();
    });
    beforeEach(async () => {
      for (const t of ["slice_tombstones", "merge_vetoes", "merge_proposals", "user_merges", "user_aliases", "mcp_credentials", "bindings", "boundaries", "users", "slack_identities", "accounts", "agent_grants", "sessions", "audit_events"]) {
        await db.run(`DELETE FROM ${t}`);
      }
      if (dialect === "pg") {
        await db.run("DELETE FROM slack_apps");
        await db.run("DELETE FROM tenants WHERE id <> 'default'");
        await db.run("INSERT INTO slack_apps (api_app_id, team_id, tenant_id, bot_token, signing_secret, created_at, updated_at) VALUES ('A0', ?, 'default', 'x', 'y', 1, 1)", [WS]);
      }
    });
    const opts = (o: ReconcileOptions = {}): ReconcileOptions => ({ db, liveTeamIds: () => [WS], audit: async () => {}, ...o });
    const flag = dialect === "pg" ? true : 1;

    async function account(sub: string): Promise<{ accountId: string; userId: string }> {
      await db.run("INSERT INTO accounts (id, issuer, subject, email, email_proven, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)", [`acc-${sub}`, ISS, sub, `${sub}@example.com`, flag]);
      const u = await Domain.ensureUser({}, db);
      await Domain.ensureBinding({ service: "oidc", kind: "subject", workspace: ISS, value: sub, userId: u.id, state: "verified", source: "test" }, db);
      return { accountId: `acc-${sub}`, userId: u.id };
    }
    const cred = (id: string, accountId: string, ptr: string | null = null) =>
      db.run("INSERT INTO mcp_credentials (id, account_id, server_key, payload, expires_at, updated_at, user_id) VALUES (?, ?, ?, 'ciphertext', 1, 1, ?)", [id, accountId, `k-${id}`, ptr]);
    const ptr = async (id: string) => (await db.one<{ user_id: string | null }>("SELECT user_id FROM mcp_credentials WHERE id = ?", [id]))!.user_id;
    const bind = (userId: string, value: string, state: Domain.State = "verified", team = WS) =>
      Domain.ensureBinding({ service: "slack", kind: "user", workspace: team, value, userId, state, source: "test" }, db);
    const snapshot = async () =>
      JSON.stringify([
        await db.query("SELECT id, user_id, state, value FROM bindings ORDER BY id"),
        await db.query("SELECT * FROM slack_identities ORDER BY team_id, slack_user_id"),
        await db.query("SELECT id, account_id, payload, expires_at FROM mcp_credentials ORDER BY id"),
      ]);

    test("a verified slack binding with no link is counted per team, no id printed", async () => {
      const a = await account("a");
      await bind(a.userId, "U0AEXAMPLE", "verified", WS);
      await bind(a.userId, "U1AEXAMPLE", "verified", WS2);
      await bind(a.userId, "U2AEXAMPLE", "observed", WS); // not verified: not counted
      const r = await sliceReport(db, { fill: false, pageSize: 500 });
      expect(r.verifiedWithoutLink).toEqual({ total: 2, byTeam: { [WS]: 1, [WS2]: 1 } });
      expect(r.linkWithoutVerified.total).toBe(0);
    });

    test("a link that has a verified binding is clean, and a link with none is counted (the reverse direction)", async () => {
      const a = await account("a");
      await bind(a.userId, "U0AEXAMPLE");
      await db.run("INSERT INTO slack_identities (team_id, slack_user_id, account_id, linked_at, linked_via) VALUES (?, 'U0AEXAMPLE', ?, 1, 'test')", [WS, a.accountId]);
      expect((await sliceReport(db, { fill: false, pageSize: 500 })).verifiedWithoutLink.total).toBe(0);
      expect((await sliceReport(db, { fill: false, pageSize: 500 })).linkWithoutVerified.total).toBe(0);
      await db.run("INSERT INTO slack_identities (team_id, slack_user_id, account_id, linked_at, linked_via) VALUES (?, 'U9AEXAMPLE', ?, 1, 'test')", [WS2, a.accountId]);
      await db.run("UPDATE bindings SET state = 'observed' WHERE value = 'U0AEXAMPLE'");
      const r = await sliceReport(db, { fill: false, pageSize: 500 });
      expect(r.linkWithoutVerified).toEqual({ total: 2, byTeam: { [WS]: 1, [WS2]: 1 } });
    });

    test("credential pointers: NULL, drifted, unresolved and correct are told apart", async () => {
      const a = await account("a");
      const b = await account("b");
      await db.run("INSERT INTO accounts (id, issuer, subject, email, email_proven, created_at, updated_at) VALUES ('acc-c', ?, 'c', 'c@example.com', ?, 1, 1)", [ISS, flag]); // no user yet
      await cred("c1", a.accountId, null);
      await db.run("INSERT INTO mcp_credentials (id, account_id, server_key, payload, expires_at, updated_at, user_id) VALUES ('c2', ?, 'k2', 'x', 1, 1, ?)", [a.accountId, a.userId]);
      await db.run("INSERT INTO mcp_credentials (id, account_id, server_key, payload, expires_at, updated_at, user_id) VALUES ('c3', ?, 'k3', 'x', 1, 1, ?)", [b.accountId, a.userId]); // drift
      await db.run("INSERT INTO mcp_credentials (id, account_id, server_key, payload, expires_at, updated_at, user_id) VALUES ('c4', 'acc-c', 'k4', 'x', 1, 1, NULL)");
      await db.run("INSERT INTO mcp_credentials (id, agent_tenant, agent_persona, server_key, payload, expires_at, updated_at) VALUES ('c5', 't', 'p', 'k', 'x', 1, 1)");
      const r = await sliceReport(db, { fill: false, pageSize: 2 });
      expect(r.pointers).toEqual({ total: 4, nullPointer: 2, drift: 1, unresolved: 1, filled: 0, repaired: 0 });
    });

    test("fill sets EMPTY pointers only, never a set one, and is idempotent; a report-only run writes nothing", async () => {
      const a = await account("a");
      const b = await account("b");
      await cred("c1", a.accountId, null);
      await db.run("INSERT INTO mcp_credentials (id, account_id, server_key, payload, expires_at, updated_at, user_id) VALUES ('c3', ?, 'k3', 'x', 1, 1, ?)", [b.accountId, a.userId]); // drift stays
      const before = await snapshot();
      await sliceReport(db, { fill: false, pageSize: 500 });
      expect(await snapshot()).toBe(before);
      expect((await sliceReport(db, { fill: true, pageSize: 500 })).pointers.filled).toBe(1);
      expect(await ptr("c1")).toBe(a.userId);
      expect(await ptr("c3")).toBe(a.userId); // the drifted pointer was not touched
      expect((await sliceReport(db, { fill: true, pageSize: 500 })).pointers).toMatchObject({ filled: 0, nullPointer: 0, drift: 1 });
    });

    test("drift is repaired only with SLAUDE_CREDENTIAL_POINTERS=on and fill, by compare-and-set", async () => {
      const a = await account("a");
      const b = await account("b");
      await db.run("INSERT INTO mcp_credentials (id, account_id, server_key, payload, expires_at, updated_at, user_id) VALUES ('c3', ?, 'k3', 'x', 1, 1, ?)", [b.accountId, a.userId]);
      expect((await sliceReport(db, { fill: true, pageSize: 500 })).pointers).toMatchObject({ drift: 1, repaired: 0 });
      expect(await ptr("c3")).toBe(a.userId);
      process.env.SLAUDE_CREDENTIAL_POINTERS = "on";
      try {
        expect((await sliceReport(db, { fill: false, pageSize: 500 })).pointers.repaired).toBe(0);
        expect((await sliceReport(db, { fill: true, pageSize: 500 })).pointers).toMatchObject({ drift: 1, repaired: 1 });
        expect(await ptr("c3")).toBe(b.userId);
        expect((await sliceReport(db, { fill: true, pageSize: 500 })).pointers).toMatchObject({ drift: 0, repaired: 0 });
      } finally {
        delete process.env.SLAUDE_CREDENTIAL_POINTERS;
      }
    });

    test("through reconcile: a dry run never fills; a plain run reports; fillPointers fills; payloads and links are untouched", async () => {
      const a = await account("a");
      await cred("c1", a.accountId, null);
      const dry = await reconcile(opts({ dryRun: true, fillPointers: true }));
      expect(dry.slices.pointers.filled).toBe(0);
      expect(await ptr("c1")).toBeNull();
      const plain = await reconcile(opts());
      expect(plain.slices.pointers.nullPointer).toBe(1);
      expect(await ptr("c1")).toBeNull();
      const before = await db.query("SELECT id, account_id, payload, expires_at FROM mcp_credentials");
      const applied = await reconcile(opts({ fillPointers: true }));
      expect(applied.slices.pointers.filled).toBe(1);
      expect(await ptr("c1")).toBe(a.userId);
      expect(await db.query("SELECT id, account_id, payload, expires_at FROM mcp_credentials")).toEqual(before);
      expect((await reconcile(opts({ fillPointers: true }))).slices.pointers.filled).toBe(0);
    });

    test("a slice name two live users both produce is reported masked, with a user count", async () => {
      const a = await account("a");
      const b = await account("b");
      const c = await account("c");
      await bind(a.userId, "U0SECRETEXAMPLE", "verified", WS);
      await bind(b.userId, "U0SECRETEXAMPLE", "observed", WS2);
      await bind(c.userId, "U1SECRETEXAMPLE", "verified", WS);
      const r = await sliceReport(db, { fill: false, pageSize: 1 });
      expect(r.claimedNames.total).toBe(1);
      expect(r.claimedNames.names[0]!.users).toBe(2);
      const text = formatReconcileReport({ ...(await reconcile(opts())), slices: r });
      expect(text.toLowerCase()).not.toContain("secret");
      expect(text).toContain("slice names claimed by two users: 1");
      expect(JSON.stringify(r).toLowerCase()).not.toContain("secret");
    });

    test("the report is idempotent, changes no binding, link or credential payload, and prints no Slack id", async () => {
      const a = await account("a");
      await bind(a.userId, "U0AEXAMPLE");
      await cred("c1", a.accountId, a.userId);
      const before = await snapshot();
      const r1 = await sliceReport(db, { fill: false, pageSize: 500 });
      const r2 = await sliceReport(db, { fill: false, pageSize: 500 });
      expect(r2).toEqual(r1);
      expect(await snapshot()).toBe(before);
      const text = JSON.stringify(r1) + formatReconcileReport({ ...(await reconcile(opts({ dryRun: true }))), slices: r1 });
      expect(text).not.toContain("U0AEXAMPLE");
    });
  });
}

describe("boot hook", () => {
  test("skips the slice report and says where to read it", async () => {
    const lines: string[] = [];
    let seen: { skipSliceReport?: boolean } = {};
    const base = await reconcile({ db: await openDb({ dialect: "sqlite", path: ":memory:" }), liveTeamIds: () => [WS], audit: async () => {} });
    await reconcileAtBoot({ role: "mono", liveTeamIds: () => [WS], run: async (o) => ((seen = o), base), log: (m) => lines.push(m) });
    expect(seen.skipSliceReport).toBe(true);
    expect(lines.join("\n")).toContain("slaude domain reconcile --dry-run prints it");
  });

  test("a run that skips the report does not read bindings or credentials for it", async () => {
    const mem = await openDb({ dialect: "sqlite", path: ":memory:" });
    const spy = (await import("bun:test")).spyOn(mem, "query");
    await reconcile({ db: mem, liveTeamIds: () => [WS], audit: async () => {}, skipSliceReport: true });
    expect(spy.mock.calls.some((c) => String(c[0]).includes("FROM mcp_credentials"))).toBe(false);
    expect(spy.mock.calls.some((c) => String(c[0]).includes("service = 'slack' AND kind = 'user' AND id >"))).toBe(false);
    await mem.close();
  });
});
