/** Small world builder for the person-slice tests: users, Slack bindings in a state, placeholders only. */
import * as Domain from "../../src/db/domain";
import { db } from "../../src/db/schema";
import * as Accounts from "../../src/db/accounts";
import { invalidateActors } from "../../src/refs/actor";

export const TEAM = "T0EXAMPLE";
export const TEAM2 = "T1EXAMPLE";

/** Tests of the resolver run with the hold off unless they set it themselves after this. */
export async function resetWorld(): Promise<void> {
  process.env.SLAUDE_PERSON_SLICES_HOLD_HOURS = "0";
  await Accounts._wipeForTests();
  await db.run("DELETE FROM slice_tombstones");
  invalidateActors();
}

export async function newUser(): Promise<string> {
  return (await Domain.ensureUser({})).id;
}

/**
 * A Slack binding on a user. A VERIFIED one also gets the authoritative link (a row in
 * `slack_identities` for an account whose oidc binding is on this user), as a real portal link
 * does; pass `{ link: false }` for the verified-binding-with-no-link case.
 */
export async function slack(userId: string, value: string, state: Domain.State = "verified", team: string = TEAM, opts: { link?: boolean } = {}): Promise<string> {
  const r = await Domain.ensureBinding({ service: "slack", kind: "user", workspace: team, value, userId, state, source: "test" });
  if (state === "verified" && opts.link !== false) await linkFor(userId, value, team);
  invalidateActors();
  return r.binding.id;
}

/** The authoritative link of one Slack id to a (helper-made) account of this user. */
export async function linkFor(userId: string, value: string, team: string = TEAM): Promise<void> {
  const accountId = `acc-${userId}`;
  const exists = await db.one("SELECT id FROM accounts WHERE id = ?", [accountId]);
  if (!exists) {
    const flag = db.dialect === "pg" ? false : 0;
    await db.run("INSERT INTO accounts (id, issuer, subject, email, email_proven, created_at, updated_at) VALUES (?, 'https://idp.example.com', ?, ?, ?, 1, 1)", [accountId, `sub-${userId}`, `${userId}@example.com`, flag]);
    await Domain.ensureBinding({ service: "oidc", kind: "subject", workspace: "https://idp.example.com", value: `sub-${userId}`, userId, state: "verified", source: "test" });
  }
  await db.run("INSERT INTO slack_identities (team_id, slack_user_id, account_id, linked_at, linked_via) VALUES (?, ?, ?, 1, 'test') ON CONFLICT DO NOTHING", [team, value, accountId]);
}

/** Slice name a Slack id maps to (mirror of userSourceId for plain alphanumeric ids). */
export const nameOf = (value: string): string => ("user-" + value.toLowerCase().replace(/[^a-z0-9]/g, "")).slice(0, 32);

/** For afterAll in a file that writes through the global database (real Postgres keeps rows across files): every table these tests touch. */
export async function cleanWorld(): Promise<void> {
  await resetWorld();
  for (const t of ["mcp_credentials", "link_token_uses", "audit_events", "slice_tombstones", "merge_vetoes", "merge_proposals", "user_merges"]) await db.run(`DELETE FROM ${t}`);
  delete process.env.SLAUDE_PERSON_SLICES_HOLD_HOURS;
}
