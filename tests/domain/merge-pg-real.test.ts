import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import * as Domain from "../../src/db/domain";
import type { DbClient } from "../../src/db/client";
import { openBunSql } from "../../src/db/drivers/pg";
import { runMigrations } from "../../src/db/migrate";
import { mergeUsers } from "../../src/domain/merge";
import { undoMerge } from "../../src/domain/merge-undo";

/**
 * The merge engine against a REAL Postgres server, two connections racing
 * (PGLite is one connection and cannot model row locks). Gated like
 * tests/db/pg-real.test.ts on SLAUDE_PG_TEST_URL (or SLAUDE_PG_URL); each test
 * runs in its own scratch database.
 */
const BASE_URL = process.env.SLAUDE_PG_TEST_URL ?? process.env.SLAUDE_PG_URL ?? "";
const enabled = BASE_URL.length > 0;

async function withScratchDb<T>(fn: (a: DbClient, b: DbClient) => Promise<T>): Promise<T> {
  const admin = await openBunSql(BASE_URL);
  const name = `slaude_scratch_${randomBytes(6).toString("hex")}`;
  await admin.exec(`CREATE DATABASE ${name}`);
  const u = new URL(BASE_URL);
  u.pathname = `/${name}`;
  const a = await openBunSql(u.toString());
  const b = await openBunSql(u.toString());
  try {
    await runMigrations(a, { log: () => {} });
    return await fn(a, b);
  } finally {
    await a.close().catch(() => {});
    await b.close().catch(() => {});
    await admin.exec(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.close();
  }
}

const TEAM = "T0EXAMPLE";
const slack = (value: string) => ({ service: "slack", kind: "user", workspace: TEAM, value });
async function person(c: DbClient, value: string, extra: { oidc?: string } = {}): Promise<string> {
  const r = await Domain.ensureBinding({ ...slack(value), state: "observed", source: "test" }, c);
  if (extra.oidc) await Domain.ensureBinding({ service: "oidc", kind: "subject", workspace: "https://idp.example.com", value: extra.oidc, userId: r.userId, state: "verified", source: "test" }, c);
  return r.userId;
}
const n = async (c: DbClient, sql: string) => Number((await c.one<{ n: number | string }>(sql))!.n);

describe.skipIf(!enabled)("merge engine on real Postgres, two connections", () => {
  test("a into b on one connection and b into a on the other give one applied row", async () => {
    await withScratchDb(async (c1, c2) => {
      for (let round = 0; round < 5; round++) {
        const a = await person(c1, `U0AAA${round}`);
        const b = await person(c1, `U0BBB${round}`);
        const [x, y] = await Promise.all([
          c1.transaction((tx) => mergeUsers({ survivorId: b, loserId: a, kind: "console", actor: "UOP" }, tx)),
          c2.transaction((tx) => mergeUsers({ survivorId: a, loserId: b, kind: "console", actor: "UOP" }, tx)),
        ]);
        expect([x.status, y.status].sort()).toEqual(["merged", "noop"]);
        expect(await n(c1, `SELECT COUNT(*) AS n FROM user_merges WHERE state = 'applied' AND loser_id IN ('${a}', '${b}')`)).toBe(1);
        const live = await Domain.resolveUserId(a, c1);
        expect(await Domain.resolveUserId(b, c1)).toBe(live);
        expect(await n(c1, `SELECT COUNT(*) AS n FROM bindings WHERE user_id = '${live}'`)).toBe(2);
      }
    });
  });

  test("two proofs adopting one held binding onto different users: one merge, the other a conflict", async () => {
    await withScratchDb(async (c1, c2) => {
      for (let round = 0; round < 5; round++) {
        const held = await person(c1, `U0HELD${round}`);
        const s1 = await person(c1, `U0ONE${round}`, { oidc: `sub-a${round}` });
        const s2 = await person(c1, `U0TWO${round}`, { oidc: `sub-b${round}` });
        const key = slack(`U0HELD${round}`);
        const [x, y] = await Promise.all([
          c1.transaction((tx) => Domain.adoptBinding({ ...key, toUserId: s1, state: "verified" }, tx)),
          c2.transaction((tx) => Domain.adoptBinding({ ...key, toUserId: s2, state: "verified" }, tx)),
        ]);
        expect([x.adopted, y.adopted].filter(Boolean).length).toBe(1);
        expect(await n(c1, `SELECT COUNT(*) AS n FROM user_merges WHERE state = 'applied' AND loser_id = '${held}'`)).toBe(1);
        expect(await Domain.getUser(held, c1)).toBeNull();
      }
    });
  });

  test("a merge racing an unlink of one of the loser's bindings leaves no orphan and no half move", async () => {
    await withScratchDb(async (c1, c2) => {
      for (let round = 0; round < 8; round++) {
        const s = await person(c1, `U0SURV${round}`);
        const l = await person(c1, `U0LOSE${round}`);
        await Domain.ensureBinding({ service: "slack", kind: "user", workspace: TEAM, value: `U0EXTRA${round}`, userId: l, state: "observed", source: "test" }, c1);
        const [m] = await Promise.all([
          c1.transaction((tx) => mergeUsers({ survivorId: s, loserId: l, kind: "console", actor: "UOP" }, tx)),
          c2.transaction((tx) => tx.run("DELETE FROM bindings WHERE workspace = ? AND value = ?", [TEAM, `U0EXTRA${round}`])),
        ]);
        expect(["merged", "refused"]).toContain(m.status);
        expect(await n(c1, "SELECT COUNT(*) AS n FROM bindings b LEFT JOIN users u ON u.id = b.user_id WHERE u.id IS NULL")).toBe(0);
        if (m.status === "merged") {
          expect(await Domain.getUser(l, c1)).toBeNull();
          expect(await n(c1, `SELECT COUNT(*) AS n FROM bindings WHERE user_id = '${l}'`)).toBe(0);
        } else {
          expect(await Domain.getUser(l, c1)).not.toBeNull();
        }
      }
    });
  });
  test("an undo racing a merge of its survivor, and two undos of one merge, end consistent", async () => {
    await withScratchDb(async (c1, c2) => {
      for (let round = 0; round < 6; round++) {
        const s = await person(c1, `U0SUR${round}`);
        const l = await person(c1, `U0LOS${round}`);
        const x = await person(c1, `U0XXX${round}`);
        const first = await c1.transaction((tx) => mergeUsers({ survivorId: s, loserId: l, kind: "console", actor: "UOP" }, tx));
        if (first.status !== "merged") throw new Error("setup merge failed");
        const [u, mg] = await Promise.all([
          c1.transaction((tx) => undoMerge({ mergeId: first.merge.id, actor: "op", reason: "race" }, tx)),
          c2.transaction((tx) => mergeUsers({ survivorId: x, loserId: s, kind: "console", actor: "UOP" }, tx)),
        ]);
        expect(await n(c1, "SELECT COUNT(*) AS n FROM bindings b LEFT JOIN users u ON u.id = b.user_id WHERE u.id IS NULL")).toBe(0);
        if (u.status === "undone") expect(await Domain.getUser(l, c1)).not.toBeNull();
        else expect(u).toMatchObject({ status: "refused", reason: "chained" });
        if (u.status === "refused") expect(mg.status).toBe("merged");
        expect(await n(c1, `SELECT COUNT(*) AS n FROM user_merges WHERE state = 'applied' AND loser_id = '${l}'`)).toBe(u.status === "undone" ? 0 : 1);

        const s2 = await person(c1, `U0SUQ${round}`);
        const l2 = await person(c1, `U0LOQ${round}`);
        const m2 = await c1.transaction((tx) => mergeUsers({ survivorId: s2, loserId: l2, kind: "console", actor: "UOP" }, tx));
        if (m2.status !== "merged") throw new Error("setup merge failed");
        const [a, b] = await Promise.all([
          c1.transaction((tx) => undoMerge({ mergeId: m2.merge.id, actor: "op", reason: "race" }, tx)),
          c2.transaction((tx) => undoMerge({ mergeId: m2.merge.id, actor: "op", reason: "race" }, tx)),
        ]);
        expect([a.status, b.status].sort()).toEqual(["refused", "undone"]);
        expect(await n(c1, `SELECT COUNT(*) AS n FROM users WHERE id = '${l2}'`)).toBe(1);
      }
    });
  });
});
