import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as Accounts from "../../src/db/accounts";
import * as Domain from "../../src/db/domain";
import { db } from "../../src/db/schema";

const ISS = "https://idp.example.com";
const TEAM = "T0EXAMPLE";
const mail = (value: string) => ({ service: "email", kind: "address", workspace: "", value });
const oidc = (subject: string) => ({ service: "oidc", kind: "subject", workspace: ISS, value: subject });
const slack = (value: string) => ({ service: "slack", kind: "user", workspace: TEAM, value });
const count = async (t: string) => Number((await db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`))!.n);

async function wipeDomain() {
  await Accounts._wipeForTests();
  for (const t of ["user_aliases", "bindings", "users"]) await db.run(`DELETE FROM ${t}`);
}
beforeEach(wipeDomain);
afterEach(() => {
  spyOn(console, "warn").mockRestore();
});

describe("account projection: login", () => {
  test("login creates the user, the oidc binding and the verified email binding", async () => {
    await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "Alice@Example.com" });
    const o = await Domain.findBinding(oidc("sub-1"));
    const e = await Domain.findBinding(mail("alice@example.com"));
    expect(o?.state).toBe("verified");
    expect(e?.state).toBe("verified");
    expect(e?.user_id).toBe(o!.user_id);
    expect(await count("users")).toBe(1);
  });

  test("a second login adds nothing", async () => {
    await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    expect(await count("users")).toBe(1);
    expect(await count("bindings")).toBe(2);
  });

  test("an email change moves the verified email binding", async () => {
    await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    const userId = (await Domain.findBinding(oidc("sub-1")))!.user_id;
    await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice.new@example.com" });
    expect(await Domain.findBinding(mail("alice@example.com"))).toBeNull();
    expect((await Domain.findBinding(mail("alice.new@example.com")))?.user_id).toBe(userId);
    expect(await count("users")).toBe(1);
  });

  test("an email held by an observed user is adopted, with an alias", async () => {
    const seen = await Domain.ensureBinding({ ...mail("alice@example.com"), state: "observed", source: "test" });
    await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    const e = await Domain.findBinding(mail("alice@example.com"));
    expect(e?.state).toBe("verified");
    expect(e?.user_id).toBe((await Domain.findBinding(oidc("sub-1")))!.user_id);
    expect(await Domain.resolveUserId(seen.userId)).toBe(e!.user_id);
    expect(await count("user_aliases")).toBe(1);
  });

  test("a verified-vs-verified email clash keeps both and does not fail the login", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "shared@example.com" });
    const other = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-2", email: "shared@example.com" });
    expect(other.subject).toBe("sub-2");
    const a = (await Domain.findBinding(oidc("sub-1")))!.user_id;
    const b = (await Domain.findBinding(oidc("sub-2")))!.user_id;
    expect(a).not.toBe(b);
    expect((await Domain.findBinding(mail("shared@example.com")))!.user_id).toBe(a);
    expect(warn).toHaveBeenCalled();
  });

  test("an email that cannot normalise is skipped with a warning", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const acct = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "not an email" });
    expect(acct.email).toBe("not an email");
    expect(await Domain.findBinding(oidc("sub-1"))).not.toBeNull();
    expect(await count("bindings")).toBe(1);
    expect(warn).toHaveBeenCalled();
  });

  test("a projection error does not fail the login and rolls back only the projection", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const bad = spyOn(Domain, "adoptBinding").mockImplementation(async (_i, tx) => {
      await tx!.run("INSERT INTO bindings (id) VALUES ('broken')"); // NOT NULL violation
      throw new Error("unreachable");
    });
    try {
      const acct = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
      expect((await Accounts.findAccountBySubject(ISS, "sub-1"))?.id).toBe(acct.id);
      expect(await count("bindings")).toBe(0);
      expect(await count("users")).toBe(0);
      expect(warn).toHaveBeenCalled();
    } finally {
      bad.mockRestore();
    }
    // The next login repairs it.
    await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    expect(await count("bindings")).toBe(2);
  });
});

describe("account projection: slack link", () => {
  const link = (accountId: string, id = "U0EXAMPLE") =>
    Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: id, accountId, via: "signed-link" });

  test("link creates the verified slack binding on the account's user", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    expect(await link(a.id)).toEqual({ ok: true, created: true });
    const s = await Domain.findBinding(slack("U0EXAMPLE"));
    expect(s?.state).toBe("verified");
    expect(s?.user_id).toBe((await Domain.findBinding(oidc("sub-1")))!.user_id);
  });

  test("an observed user for that slack id is adopted and aliased", async () => {
    const seen = await Domain.ensureBinding({ ...slack("U0EXAMPLE"), state: "observed", source: "test" });
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    await link(a.id);
    const s = await Domain.findBinding(slack("U0EXAMPLE"));
    expect(s?.user_id).toBe((await Domain.findBinding(oidc("sub-1")))!.user_id);
    expect(await Domain.resolveUserId(seen.userId)).toBe(s!.user_id);
  });

  test("a replayed link is a no-op and a link to another account is refused", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    const b = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-2", email: "bob@example.com" });
    await link(a.id);
    const before = await count("bindings");
    expect(await link(a.id)).toEqual({ ok: true, created: false });
    expect(await link(b.id)).toEqual({ ok: false, reason: "already-linked", existingAccountId: a.id });
    expect(await count("bindings")).toBe(before);
    expect((await Domain.findBinding(slack("U0EXAMPLE")))!.user_id).toBe((await Domain.findBinding(oidc("sub-1")))!.user_id);
  });

  test("a projection error does not fail the link", async () => {
    spyOn(console, "warn").mockImplementation(() => {});
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    const bad = spyOn(Domain, "adoptBinding").mockImplementation(async (_i, tx) => {
      await tx!.run("INSERT INTO bindings (id) VALUES ('broken')");
      throw new Error("unreachable");
    });
    try {
      expect(await link(a.id)).toEqual({ ok: true, created: true });
    } finally {
      bad.mockRestore();
    }
    expect((await Accounts.slackIdentitiesForAccount(a.id)).length).toBe(1);
    expect(await Domain.findBinding(slack("U0EXAMPLE"))).toBeNull();
  });

  test("unlink removes the projected binding", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    await link(a.id);
    expect(await Accounts.unlinkSlackIdentity(TEAM, "U0EXAMPLE", a.id)).toBe(true);
    expect(await Domain.findBinding(slack("U0EXAMPLE"))).toBeNull();
    expect(await Domain.findBinding(oidc("sub-1"))).not.toBeNull();
  });

  test("unlink by a different account removes nothing", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    const b = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-2", email: "bob@example.com" });
    await link(a.id);
    expect(await Accounts.unlinkSlackIdentity(TEAM, "U0EXAMPLE", b.id)).toBe(false);
    expect(await Domain.findBinding(slack("U0EXAMPLE"))).not.toBeNull();
  });

  test("unlink leaves a slack binding that belongs to another user", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    await link(a.id);
    const other = await Domain.ensureUser();
    await db.run("UPDATE bindings SET user_id = ? WHERE service = 'slack'", [other.id]);
    await Accounts.unlinkSlackIdentity(TEAM, "U0EXAMPLE", a.id);
    expect(await Domain.findBinding(slack("U0EXAMPLE"))).not.toBeNull();
  });
});

describe("account projection: deletion", () => {
  test("deleting an account drops oidc and email bindings, demotes slack, and removes an empty user", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: "U0EXAMPLE", accountId: a.id, via: "signed-link" });
    const userId = (await Domain.findBinding(oidc("sub-1")))!.user_id;
    expect(await Accounts.deleteAccount(a.id)).toBe(true);
    expect(await Accounts.findAccountById(a.id)).toBeNull();
    expect(await Domain.findBinding(oidc("sub-1"))).toBeNull();
    expect(await Domain.findBinding(mail("alice@example.com"))).toBeNull();
    const s = await Domain.findBinding(slack("U0EXAMPLE"));
    expect(s?.state).toBe("observed");
    expect(s?.user_id).toBe(userId);
    expect(await Accounts.slackIdentitiesForAccount(a.id)).toEqual([]);
  });

  test("an account with no slack link leaves no user behind", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    await Accounts.deleteAccount(a.id);
    expect(await count("users")).toBe(0);
    expect(await count("bindings")).toBe(0);
  });

  test("deleting a missing account is false", async () => {
    expect(await Accounts.deleteAccount("nope")).toBe(false);
  });
});
