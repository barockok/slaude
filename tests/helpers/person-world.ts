/** Small world builder for the person-slice tests: users, Slack bindings in a state, placeholders only. */
import * as Domain from "../../src/db/domain";
import { db } from "../../src/db/schema";
import * as Accounts from "../../src/db/accounts";
import { invalidateActors } from "../../src/refs/actor";

export const TEAM = "T0EXAMPLE";
export const TEAM2 = "T1EXAMPLE";

export async function resetWorld(): Promise<void> {
  await Accounts._wipeForTests();
  await db.run("DELETE FROM slice_tombstones");
  invalidateActors();
}

export async function newUser(): Promise<string> {
  return (await Domain.ensureUser({})).id;
}

export async function slack(userId: string, value: string, state: Domain.State = "verified", team: string = TEAM): Promise<string> {
  const r = await Domain.ensureBinding({ service: "slack", kind: "user", workspace: team, value, userId, state, source: "test" });
  invalidateActors();
  return r.binding.id;
}

/** Slice name a Slack id maps to (mirror of userSourceId for plain alphanumeric ids). */
export const nameOf = (value: string): string => ("user-" + value.toLowerCase().replace(/[^a-z0-9]/g, "")).slice(0, 32);
