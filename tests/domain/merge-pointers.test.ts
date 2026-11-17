/**
 * Slice F, task 3: a merge repoints credential pointers BEFORE the loser row is
 * deleted (the delete fires ON DELETE SET NULL), inside a guarded step that can
 * never fail a link merge. Pointers are bookkeeping: merge and undo leave the
 * credential rows, payloads and slack_identities exactly as they were.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as Accounts from "../../src/db/accounts";
import * as Creds from "../../src/db/mcp-credentials";
import * as Domain from "../../src/db/domain";
import * as Pointers from "../../src/db/credential-pointers";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import { db } from "../../src/db/schema";
import { mergeUsers } from "../../src/domain/merge";
import { undoMerge } from "../../src/domain/merge-undo";
import { cleanWorld } from "../helpers/person-world";
import { UNDO_LIMITS } from "../../src/domain/merge-limits";

const TEAM = "T0EXAMPLE";
const ISS = "https://idp.example.com";
const entry = (token: string) => ({ serverName: "workbench", serverUrl: "https://mcp.example.com", accessToken: token, refreshToken: "r", expiresAt: Date.now() + 3600_000 });
const dj = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : (v as Record<string, any>));

async function observed(slack: string) {
  const u = await Domain.ensureUser({});
  await Domain.ensureBinding({ service: "slack", kind: "user", workspace: TEAM, value: slack, userId: u.id, state: "observed", source: "test" });
  return u.id;
}
/** An account with a credential whose pointer names `pointTo`. */
async function accountWithCredential(sub: string, pointTo: string) {
  const acct = await Accounts.upsertAccount({ issuer: ISS, subject: sub, email: `${sub}@example.com` });
  await Creds.putCredential({ kind: "account", accountId: acct.id }, "k", entry(`tok-${sub}`));
  await db.run("UPDATE mcp_credentials SET user_id = ? WHERE account_id = ?", [pointTo, acct.id]);
  return acct.id;
}
const pointerOf = async (accountId: string) => (await db.one<{ user_id: string | null }>("SELECT user_id FROM mcp_credentials WHERE account_id = ?", [accountId]))!.user_id;
const credSnapshot = async () => JSON.stringify(await db.query("SELECT id, account_id, server_key, payload, expires_at, updated_at FROM mcp_credentials ORDER BY id"));
const linksSnapshot = async () => JSON.stringify(await db.query("SELECT * FROM slack_identities ORDER BY team_id, slack_user_id"));

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  process.env.SLAUDE_MERGE_NOTICE = "off";
  delete process.env.SLAUDE_MERGE_POINTERS;
  await db.run("DELETE FROM mcp_credentials");
  await Accounts._wipeForTests();
  await db.run("DELETE FROM audit_events");
  spyOn(console, "warn").mockImplementation(() => {});
  spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.SLAUDE_MERGE_NOTICE;
  delete process.env.SLAUDE_MERGE_POINTERS;
  spyOn(console, "warn").mockRestore();
  spyOn(console, "log").mockRestore();
});

describe("merge repoints credential pointers", () => {
  test("pointers follow the survivor and the ledger records them", async () => {
    const survivor = await observed("U0EXAMPLE");
    const loser = await observed("U1EXAMPLE");
    const a = await accountWithCredential("sub-a", loser);
    const out = await mergeUsers({ survivorId: survivor, loserId: loser, kind: "console", actor: "UOPERATOR" });
    expect(out.status).toBe("merged");
    expect(await pointerOf(a)).toBe(survivor);
    const row = await db.one<{ id: string }>("SELECT id FROM mcp_credentials WHERE account_id = ?", [a]);
    if (out.status !== "merged") throw new Error("unreachable");
    expect(out.merge.moved.credentials).toEqual([{ id: row!.id, from: loser, to: survivor }]);
  });

  test("the pointer is repointed while the loser row still exists, so ON DELETE SET NULL never fires on it", async () => {
    const survivor = await observed("U0EXAMPLE");
    const loser = await observed("U1EXAMPLE");
    await accountWithCredential("sub-a", loser);
    const seen: boolean[] = [];
    const real = Pointers.repointForMerge;
    const spy = spyOn(Pointers, "repointForMerge").mockImplementation(async (c, l, s) => {
      seen.push((await c.one("SELECT id FROM users WHERE id = ?", [l])) !== null);
      return real(c, l, s);
    });
    try {
      await mergeUsers({ survivorId: survivor, loserId: loser, kind: "console", actor: "UOPERATOR" });
    } finally {
      spy.mockRestore();
    }
    expect(seen).toEqual([true]);
    expect((await db.one("SELECT 1 AS x FROM users WHERE id = ?", [loser]))).toBeNull();
    expect(await db.one("SELECT 1 AS x FROM mcp_credentials WHERE user_id = ?", [survivor])).not.toBeNull();
  });

  test("an injected failure after a partial write rolls back that step only: the merge is applied, the pointer is left for the reconciler", async () => {
    const survivor = await observed("U0EXAMPLE");
    const loser = await observed("U1EXAMPLE");
    const a = await accountWithCredential("sub-a", loser);
    const spy = spyOn(Pointers, "repointForMerge").mockImplementation(async (c, l, s) => {
      await c.run("UPDATE mcp_credentials SET user_id = ? WHERE user_id = ?", [s, l]); // a write, then the failure
      throw new Error("boom");
    });
    let out;
    try {
      out = await mergeUsers({ survivorId: survivor, loserId: loser, kind: "console", actor: "UOPERATOR" });
    } finally {
      spy.mockRestore();
    }
    expect(out.status).toBe("merged");
    // The step's write was rolled back (so it did not stick on the survivor); the loser delete nulled the pointer.
    expect(await pointerOf(a)).toBeNull();
    if (out.status !== "merged") throw new Error("unreachable");
    expect(out.merge.moved.credentials ?? []).toEqual([]);
    // The rest of the move stands: the binding moved and the alias exists.
    expect(await db.one("SELECT 1 AS x FROM bindings WHERE user_id = ? AND value = 'U1EXAMPLE'", [survivor])).not.toBeNull();
    expect(await db.one("SELECT 1 AS x FROM user_aliases WHERE old_id = ? AND user_id = ?", [loser, survivor])).not.toBeNull();
  });

  test("SLAUDE_MERGE_POINTERS=off skips the step", async () => {
    process.env.SLAUDE_MERGE_POINTERS = "off";
    const survivor = await observed("U0EXAMPLE");
    const loser = await observed("U1EXAMPLE");
    const a = await accountWithCredential("sub-a", loser);
    const spy = spyOn(Pointers, "repointForMerge");
    try {
      const out = await mergeUsers({ survivorId: survivor, loserId: loser, kind: "console", actor: "UOPERATOR" });
      expect(out.status).toBe("merged");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(await pointerOf(a)).toBeNull();
  });

  test("a pointer at a third user is untouched", async () => {
    const survivor = await observed("U0EXAMPLE");
    const loser = await observed("U1EXAMPLE");
    const third = await observed("U2EXAMPLE");
    const a = await accountWithCredential("sub-a", third);
    await mergeUsers({ survivorId: survivor, loserId: loser, kind: "console", actor: "UOPERATOR" });
    expect(await pointerOf(a)).toBe(third);
  });

  test("merge and undo leave credential rows, payloads and slack_identities untouched", async () => {
    const acct = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-p", email: "p@example.com" });
    await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: "U0EXAMPLE", accountId: acct.id, via: "test" });
    await Creds.putCredential({ kind: "account", accountId: acct.id }, "k", entry("tok-p"));
    const loser = await observed("U1EXAMPLE");
    const survivor = (await Domain.findBinding({ service: "oidc", kind: "subject", workspace: ISS, value: "sub-p" }))!.user_id;
    const before = { creds: await credSnapshot(), links: await linksSnapshot() };
    const out = await mergeUsers({ survivorId: survivor, loserId: loser, kind: "console", actor: "UOPERATOR" });
    if (out.status !== "merged") throw new Error(out.status);
    expect(await credSnapshot()).toBe(before.creds);
    expect(await linksSnapshot()).toBe(before.links);
    const u = await undoMerge({ mergeId: out.merge.id, actor: "op@example.com", reason: "test" });
    expect(u.status).toBe("undone");
    expect(await credSnapshot()).toBe(before.creds);
    expect(await linksSnapshot()).toBe(before.links);
    expect(dj((await db.one<{ moved: unknown }>("SELECT moved FROM user_merges"))!.moved).credentials ?? []).toEqual([]);
  });

  test("the undo limits text is accurate with the union flag off: it says what undo does only when the union is on", () => {
    const text = UNDO_LIMITS.join(" ");
    expect(text).toContain("Memory pages and credential records are never moved.");
    expect(text).toContain("If the person-slice union is enabled");
    expect(text).toContain("with it off, undo changes nothing about memory");
    expect(text).not.toContain("so undo cuts that access at once");
  });

  test("undo restores the credential pointers from the ledger (only those still at the survivor), and a failure cannot fail the undo", async () => {
    const survivor = await observed("U0EXAMPLE");
    const loser = await observed("U1EXAMPLE");
    const a = await accountWithCredential("sub-a", loser);
    const b = await accountWithCredential("sub-b", loser);
    const out = await mergeUsers({ survivorId: survivor, loserId: loser, kind: "console", actor: "UOPERATOR" });
    if (out.status !== "merged") throw new Error(out.status);
    expect(await pointerOf(a)).toBe(survivor);
    // One pointer changed since the merge: it is left alone.
    const third = await observed("U2EXAMPLE");
    await db.run("UPDATE mcp_credentials SET user_id = ? WHERE account_id = ?", [third, b]);
    const u = await undoMerge({ mergeId: out.merge.id, actor: "op@example.com", reason: "test" });
    expect(u.status).toBe("undone");
    expect(await pointerOf(a)).toBe(loser);
    expect(await pointerOf(b)).toBe(third);
    // A failing restore is logged and the undo still happens.
    const c2 = await observed("U3EXAMPLE");
    const d2 = await observed("U4EXAMPLE");
    await accountWithCredential("sub-c", d2);
    const out2 = await mergeUsers({ survivorId: c2, loserId: d2, kind: "console", actor: "UOPERATOR" });
    if (out2.status !== "merged") throw new Error(out2.status);
    const bad = spyOn(Pointers, "restorePointersForUndo").mockRejectedValue(new Error("boom"));
    try {
      expect((await undoMerge({ mergeId: out2.merge.id, actor: "op@example.com", reason: "test" })).status).toBe("undone");
    } finally {
      bad.mockRestore();
    }
  });
});

afterAll(async () => {
  await cleanWorld();
});
