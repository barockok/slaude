import { beforeEach, describe, expect, test } from "bun:test";
import * as Accounts from "../../src/db/accounts";
import { db } from "../../src/db/schema";

const ISS = "https://idp.example.com";

beforeEach(async () => {
  await Accounts._wipeForTests();
});

describe("accounts", () => {
  test("upsert creates once and is idempotent on the same subject", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    const b = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    expect(b.id).toBe(a.id);
  });

  test("upsert refreshes a changed email without changing identity", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    const b = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice.new@example.com" });
    expect(b.id).toBe(a.id);
    expect(b.email).toBe("alice.new@example.com");
  });

  test("the same subject at a different issuer is a different account", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    const b = await Accounts.upsertAccount({ issuer: "https://other.example.com", subject: "sub-1", email: "alice@example.com" });
    expect(b.id).not.toBe(a.id);
  });

  test("lookup by subject finds the account", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    expect((await Accounts.findAccountBySubject(ISS, "sub-1"))?.id).toBe(a.id);
    expect(await Accounts.findAccountBySubject(ISS, "nobody")).toBeNull();
  });
});

describe("slack identity binding", () => {
  test("links a slack user to an account and reads back", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });

    const r = await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: a.id, via: "signed-link" });

    expect(r).toEqual({ ok: true, created: true });
    expect((await Accounts.accountForSlackUser("TTESTTEAM1", "UTESTUSER1"))?.email).toBe("alice@example.com");
  });

  test("re-linking the same pair is idempotent, not an error", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: a.id, via: "signed-link" });

    const again = await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: a.id, via: "signed-link" });

    expect(again).toEqual({ ok: true, created: false });
  });

  // The whole point of the binding: a token replayed by someone else cannot
  // steal a Slack identity that is already claimed.
  test("refuses to rebind a slack user to a different account", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    const b = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-2", email: "bob@example.com" });
    await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: a.id, via: "signed-link" });

    const r = await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: b.id, via: "signed-link" });

    expect(r).toEqual({ ok: false, reason: "already-linked", existingAccountId: a.id });
    expect((await Accounts.accountForSlackUser("TTESTTEAM1", "UTESTUSER1"))?.id).toBe(a.id);
  });

  test("a refusal does not burn the token: the jti is claimed only when a link is written", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    const b = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-2", email: "bob@example.com" });
    await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: a.id, via: "signed-link" });
    const token = { jti: "burn-test", expiresAt: Date.now() + 60_000 };
    const refused = await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: b.id, via: "signed-link", token });
    expect(refused).toEqual({ ok: false, reason: "already-linked", existingAccountId: a.id });
    expect(await db.one("SELECT jti FROM link_token_uses WHERE jti = ?", ["burn-test"])).toBeNull();
    // The same account replaying a token that was never spent is a no-op 200, and spends nothing.
    const same = await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: a.id, via: "signed-link", token });
    expect(same).toEqual({ ok: true, created: false });
    expect(await db.one("SELECT jti FROM link_token_uses WHERE jti = ?", ["burn-test"])).toBeNull();
    // After an unlink, a fresh redemption links and spends it once; a replay is refused.
    await Accounts.unlinkSlackIdentity("TTESTTEAM1", "UTESTUSER1", a.id);
    expect(await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: a.id, via: "signed-link", token })).toEqual({ ok: true, created: true });
    await Accounts.unlinkSlackIdentity("TTESTTEAM1", "UTESTUSER1", a.id);
    expect(await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: a.id, via: "signed-link", token })).toEqual({ ok: false, reason: "link-used" });
  });

  test("the same slack user id in two workspaces binds independently", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    const b = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-2", email: "bob@example.com" });

    await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: a.id, via: "signed-link" });
    const second = await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM2", slackUserId: "UTESTUSER1", accountId: b.id, via: "signed-link" });

    expect(second).toEqual({ ok: true, created: true });
    expect((await Accounts.accountForSlackUser("TTESTTEAM2", "UTESTUSER1"))?.id).toBe(b.id);
  });

  test("one account can hold several slack identities", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: a.id, via: "signed-link" });
    await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM2", slackUserId: "UTESTUSER2", accountId: a.id, via: "signed-link" });

    expect(await Accounts.slackIdentitiesForAccount(a.id)).toHaveLength(2);
  });

  test("unlink only removes the caller's own binding", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    const b = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-2", email: "bob@example.com" });
    await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: a.id, via: "signed-link" });

    expect(await Accounts.unlinkSlackIdentity("TTESTTEAM1", "UTESTUSER1", b.id)).toBe(false);
    expect(await Accounts.unlinkSlackIdentity("TTESTTEAM1", "UTESTUSER1", a.id)).toBe(true);
    expect(await Accounts.accountForSlackUser("TTESTTEAM1", "UTESTUSER1")).toBeNull();
  });

  test("an unbound slack user resolves to null", async () => {
    expect(await Accounts.accountForSlackUser("TTESTTEAM1", "UNBOUND1")).toBeNull();
  });
});
