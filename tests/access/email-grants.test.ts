/**
 * Slice C task 22, the acceptance flow of rc.20 on real records, through the
 * grant store and the access seam with SLAUDE_ACCESS_SOURCE=internal:
 *  - an unlinked user gets nothing from an `email:` grant;
 *  - after a login with email_verified true and the portal link, the same user is admitted;
 *  - a manager grant by email works only once the Slack binding is verified;
 *  - unlinking removes privileged access at once.
 * And the source guard: email and user references are accepted only under internal.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { __resetDecide, decideAdmit, decideRole } from "../../src/access/decide";
import { grantState } from "../../src/access/grant-state";
import { grantFromRow } from "../../src/access/grants";
import { invalidateGrants, loadGrants } from "../../src/access/role";
import * as Accounts from "../../src/db/accounts";
import * as AgentGrants from "../../src/db/agent-grants";
import * as Domain from "../../src/db/domain";
import { db } from "../../src/db/schema";
import { metrics } from "../../src/metrics";
import * as Actor from "../../src/refs/actor";

const ISS = "https://idp.example.com";
const TEAM = "T0EXAMPLE";
const SLACK = "U0EXAMPLE";
const MAIL = "alice@example.com";
const PERSONA = "scout";

let saved: string | undefined;
beforeEach(async () => {
  saved = process.env.SLAUDE_ACCESS_SOURCE;
  process.env.SLAUDE_ACCESS_SOURCE = "internal";
  await Accounts._wipeForTests();
  for (const t of ["agent_grants", "user_aliases", "bindings", "users"]) await db.run(`DELETE FROM ${t}`);
  invalidateGrants();
  Actor.invalidateActors();
  __resetDecide();
  spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  if (saved === undefined) delete process.env.SLAUDE_ACCESS_SOURCE;
  else process.env.SLAUDE_ACCESS_SOURCE = saved;
  mock.restore();
  // Leave nothing behind for the next file: accounts, links, grants and records.
  await Accounts._wipeForTests();
  for (const t of ["agent_grants", "user_aliases", "bindings", "users"]) await db.run(`DELETE FROM ${t}`);
  invalidateGrants();
  Actor.invalidateActors();
});

const grantEmail = (role: "member" | "manager" | "approver", o: { deny?: boolean; address?: string } = {}) =>
  AgentGrants.create({ persona: PERSONA, subject: `email:${o.address ?? MAIL}`, role, deny: o.deny, createdBy: "operator@example.com" });
const admit = async () => decideAdmit({ site: "test.admit", persona: PERSONA, teamId: TEAM, userId: SLACK, channelId: "D0DM", isDM: true, grants: await loadGrants(PERSONA) });
const role = async () => decideRole({ site: "test.role", persona: PERSONA, teamId: TEAM, userId: SLACK, channelId: null, grants: await loadGrants(PERSONA) });
const login = (proven: boolean) => Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: MAIL, emailProven: proven });
const link = async () => {
  const acct = (await db.one<{ id: string }>("SELECT id FROM accounts WHERE issuer = ? AND subject = ?", [ISS, "sub-1"]))!;
  expect(await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: SLACK, accountId: acct.id, via: "portal" })).toMatchObject({ ok: true });
  Actor.invalidateActors();
  return acct.id;
};
/** The Slack user's first message: the gateway records an observed binding. */
const firstSight = () => Domain.ensureBinding({ service: "slack", kind: "user", workspace: TEAM, value: SLACK, state: "observed", source: "slack-event" });

describe("an email member grant", () => {
  test("an unlinked user gets nothing", async () => {
    await grantEmail("member");
    await firstSight();
    expect(await admit()).toEqual({ ok: false, reason: "whitelist" });
  });

  test("a login with an unproven email still gets nothing, even once linked", async () => {
    await grantEmail("member");
    await login(false);
    await link();
    expect(await admit()).toEqual({ ok: false, reason: "whitelist" });
    expect(await grantState(grantFromRow((await AgentGrants.listForPersona(PERSONA))[0]!))).toBe("pending: no verified email binding");
  });

  test("after a login with email_verified true and the portal link the same user is admitted", async () => {
    await grantEmail("member");
    await firstSight();
    expect(await admit()).toEqual({ ok: false, reason: "whitelist" });
    await login(true);
    await link();
    expect(await admit()).toEqual({ ok: true });
    expect(metrics.render()).toContain('slaude_access_decision_total{result="ok",site="test.admit",source="internal"}');
  });

  test("the stored grant records the reference, a declared email binding and the user", async () => {
    const row = await grantEmail("member", { address: "Alice@Example.com" });
    expect(row).toMatchObject({ subjectKind: "user", subjectId: `email:${MAIL}`, subjectRef: `email:${MAIL}` });
    const b = await Domain.findBinding({ service: "email", kind: "address", workspace: "", value: MAIL });
    expect(b?.state).toBe("declared");
    expect(row.subjectUserId).toBe(b!.user_id);
    // The declared binding grants nothing: a person who never proved the address is not admitted.
    await firstSight();
    expect(await admit()).toEqual({ ok: false, reason: "whitelist" });
  });

  test("the login adopts the declared record and the same grant then reaches the person", async () => {
    await grantEmail("member");
    await login(true);
    const adopted = await Domain.findBinding({ service: "email", kind: "address", workspace: "", value: MAIL });
    expect(adopted?.state).toBe("verified");
    await link();
    expect(await admit()).toEqual({ ok: true });
  });
});

describe("a manager grant by email", () => {
  test("works only once the Slack binding is verified", async () => {
    await grantEmail("manager");
    await login(true);
    await firstSight(); // an observed Slack binding on another record
    expect(await role()).toBeNull();
    await link(); // the portal link adopts the Slack binding as verified
    expect(await role()).toBe("manager");
    expect(await grantState(grantFromRow((await AgentGrants.listForPersona(PERSONA))[0]!))).toBe("active");
  });

  test("is pending while the Slack account is not linked", async () => {
    await grantEmail("manager");
    await login(true);
    expect(await grantState(grantFromRow((await AgentGrants.listForPersona(PERSONA))[0]!))).toBe("pending: Slack binding not verified");
  });

  test("unlinking removes privileged access at once, without waiting for any cache", async () => {
    await grantEmail("manager");
    await login(true);
    const accountId = await link();
    expect(await role()).toBe("manager");
    expect(await Accounts.unlinkSlackIdentity(TEAM, SLACK, accountId)).toBe(true);
    expect(await role()).not.toBe("manager");
  });

  test("a deny by email blocks the linked person at once", async () => {
    await grantEmail("member", { deny: true });
    await login(true);
    await link();
    expect(await admit()).toEqual({ ok: false, reason: "blocked_user" });
  });
});

describe("user references", () => {
  test("a reference to an existing user is stored with the live user id", async () => {
    const u = await Domain.ensureUser({});
    const row = await AgentGrants.create({ persona: PERSONA, subject: `user:${u.id}`, role: "member", createdBy: "operator@example.com" });
    expect(row).toMatchObject({ subjectId: `user:${u.id}`, subjectRef: `user:${u.id}`, subjectUserId: u.id });
  });

  test("a reference to no record is refused", async () => {
    await expect(AgentGrants.create({ persona: PERSONA, subject: "user:no-such-user", role: "member", createdBy: "operator@example.com" })).rejects.toThrow(/names no record/);
  });
});

describe("only under SLAUDE_ACCESS_SOURCE=internal", () => {
  for (const source of ["unset", "shadow", "legacy"]) {
    test(`${source}: an email or user subject is refused with the existing message, and nothing is written`, async () => {
      if (source === "unset") delete process.env.SLAUDE_ACCESS_SOURCE;
      else process.env.SLAUDE_ACCESS_SOURCE = source;
      for (const subject of [`email:${MAIL}`, "user:u-1"]) {
        await expect(AgentGrants.create({ persona: PERSONA, subject, role: "member", createdBy: "operator@example.com" })).rejects.toThrow("a non-Slack subject is not supported until the access flip");
      }
      expect(await AgentGrants.listAll()).toEqual([]);
      expect(await Domain.findBinding({ service: "email", kind: "address", workspace: "", value: MAIL })).toBeNull();
    });
  }

  test("a Slack subject works under every source, unchanged", async () => {
    for (const source of ["unset", "shadow", "legacy", "internal"]) {
      if (source === "unset") delete process.env.SLAUDE_ACCESS_SOURCE;
      else process.env.SLAUDE_ACCESS_SOURCE = source;
      const row = await AgentGrants.create({ persona: PERSONA, subject: `slack:user:${TEAM}/U0${source.toUpperCase().slice(0, 4)}X`, role: "member", createdBy: "operator@example.com" });
      expect(row.subjectId).toMatch(/^U0/);
      expect(row.subjectRef).toContain("slack:user:");
    }
  });

  test("a stored email grant is inert once the source is not internal (a stored row, a flip back)", async () => {
    await grantEmail("member");
    await login(true);
    await link();
    process.env.SLAUDE_ACCESS_SOURCE = "shadow";
    expect(await admit()).toEqual({ ok: false, reason: "whitelist" });
    expect(await grantState(grantFromRow((await AgentGrants.listForPersona(PERSONA))[0]!))).toBe("inactive: access source is not internal");
  });
});
