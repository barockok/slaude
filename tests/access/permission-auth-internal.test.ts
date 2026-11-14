/**
 * Slice C task 21: who may decide a permission card under SLAUDE_ACCESS_SOURCE=internal.
 * The initiator and the lock owner are the same person by Rule G (the same Slack
 * binding, or two verified bindings of one user, never an observed one joining a
 * verified one); an approver or manager is decided over the grants by user.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { __resetDecide } from "../../src/access/decide";
import type { Grant } from "../../src/access/grants";
import { canDecidePermission } from "../../src/access/permission-auth";
import { __setGrantsReader } from "../../src/access/role";
import { settleShadows } from "../../src/access/wired";
import * as Domain from "../../src/db/domain";
import * as Actor from "../../src/refs/actor";

const TEAM = "T0EXAMPLE";
const MAIL = "boss@example.com";
const g = (o: Partial<Grant> & Pick<Grant, "subjectKind" | "subjectId">): Grant => ({ role: "member", deny: false, dmOnly: false, source: "console", ...o });
const emailGrant = (address: string, role: Grant["role"]) => g({ subjectKind: "user", subjectId: `email:${address}`, role, subject: { service: "email", address } });

let saved: string | undefined;
let grants: Grant[] = [];
beforeEach(async () => {
  saved = process.env.SLAUDE_ACCESS_SOURCE;
  process.env.SLAUDE_ACCESS_SOURCE = "internal";
  await Domain._wipeForTests();
  Actor.invalidateActors();
  __resetDecide();
  grants = [];
  __setGrantsReader(async () => grants);
  spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  await settleShadows();
  __setGrantsReader(null);
  if (saved === undefined) delete process.env.SLAUDE_ACCESS_SOURCE;
  else process.env.SLAUDE_ACCESS_SOURCE = saved;
  mock.restore();
});

const slack = (id: string, state: "observed" | "verified", userId?: string) =>
  Domain.ensureBinding({ service: "slack", kind: "user", workspace: TEAM, value: id, state, source: "test", ...(userId ? { userId } : {}) });
const args = (o: Partial<Parameters<typeof canDecidePermission>[0]>) => ({ clicker: "U0CLICK", initiator: null, lockOwner: null, persona: "scout", channel: "C0EXAMPLE", teamId: TEAM, lockTeamId: TEAM, ...o });

describe("initiator and lock owner (Rule G)", () => {
  test("the same Slack binding is the same person with no lookup", async () => {
    expect(await canDecidePermission(args({ initiator: "U0CLICK" }))).toBe(true);
    expect(await canDecidePermission(args({ lockOwner: "U0CLICK" }))).toBe(true);
  });

  test("two verified Slack bindings of one user are the same person", async () => {
    const a = await slack("U0CLICK", "verified");
    await slack("U0OTHER", "verified", a.userId);
    expect(await canDecidePermission(args({ initiator: "U0OTHER" }))).toBe(true);
    expect(await canDecidePermission(args({ lockOwner: "U0OTHER" }))).toBe(true);
  });

  test("an observed binding never joins a verified one", async () => {
    const a = await slack("U0CLICK", "verified");
    await slack("U0OTHER", "observed", a.userId);
    expect(await canDecidePermission(args({ initiator: "U0OTHER" }))).toBe(false);
    expect(await canDecidePermission(args({ lockOwner: "U0OTHER" }))).toBe(false);
  });

  test("the same U id in another workspace is another person", async () => {
    expect(await canDecidePermission(args({ lockOwner: "U0CLICK", lockTeamId: "T0OTHER" }))).toBe(false);
  });

  test("a stranger is refused", async () => {
    expect(await canDecidePermission(args({ initiator: "U0OTHER", lockOwner: "U0THIRD" }))).toBe(false);
  });
});

describe("the role over the persona's grants", () => {
  test("a manager by email with a verified Slack binding may decide", async () => {
    grants = [emailGrant(MAIL, "manager")];
    const s = await slack("U0CLICK", "verified");
    await Domain.ensureBinding({ service: "email", kind: "address", workspace: "", value: MAIL, state: "verified", source: "test", userId: s.userId });
    expect(await canDecidePermission(args({}))).toBe(true);
  });

  test("with an observed Slack binding they may not", async () => {
    grants = [emailGrant(MAIL, "manager")];
    const s = await slack("U0CLICK", "observed");
    await Domain.ensureBinding({ service: "email", kind: "address", workspace: "", value: MAIL, state: "verified", source: "test", userId: s.userId });
    expect(await canDecidePermission(args({}))).toBe(false);
  });

  test("a click with no resolvable user and no initiator is refused", async () => {
    grants = [emailGrant(MAIL, "manager")];
    expect(await canDecidePermission(args({}))).toBe(false);
  });

  test("a resolver outage refuses a manager (never taken from legacy), but the initiator still decides its own card", async () => {
    grants = [{ ...g({ subjectKind: "user", subjectId: "U0CLICK", role: "manager", subject: { service: "slack" } }) }];
    spyOn(Domain, "findBinding").mockRejectedValue(new Error("db down"));
    expect(await canDecidePermission(args({}))).toBe(false);
    expect(await canDecidePermission(args({ initiator: "U0CLICK" }))).toBe(true);
  });
});
