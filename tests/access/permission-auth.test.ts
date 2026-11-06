import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { setSoulData, __resetSoulDataMemo } from "../../src/soul/extract";
import { SoulDataSchema } from "../../src/soul/data";
import { canDecidePermission, type PermissionDeciderArgs } from "../../src/access/permission-auth";
import { interimRoleOf } from "../../src/access/role-interim";

const any = (userId: string) => ({ userId, scope: "anything", catchall: true });

beforeAll(() => {
  setSoulData(SoulDataSchema.parse({
    manager: { userId: "UMGR" },
    backupManager: { userId: "UBACKUP" },
    approvers: [any("UGLOBAL")],
    channelOverrides: [
      { channel: "CTEAM", approvers: [any("UCHANAPP")] },
      { channel: "COTHER", approvers: [any("UOTHERAPP")] },
    ],
  }));
});
afterAll(() => __resetSoulDataMemo());

const base: Omit<PermissionDeciderArgs, "clicker"> = { initiator: "UALICE", lockOwner: null, persona: "default", channel: "CTEAM" };

describe("canDecidePermission", () => {
  const cases: [string, Partial<PermissionDeciderArgs> & { clicker: string }, boolean][] = [
    ["the initiator", { clicker: "UALICE" }, true],
    ["the /1on1 lock owner", { clicker: "UOWNER", lockOwner: "UOWNER" }, true],
    ["the manager", { clicker: "UMGR" }, true],
    ["the backup manager", { clicker: "UBACKUP" }, true],
    ["a global approver", { clicker: "UGLOBAL" }, true],
    ["an approver of this channel", { clicker: "UCHANAPP" }, true],
    ["an approver of another channel", { clicker: "UOTHERAPP" }, false],
    ["a random member", { clicker: "UBOB" }, false],
    ["a random member when there is no initiator", { clicker: "UBOB", initiator: null }, false],
    ["an approver when there is no initiator", { clicker: "UGLOBAL", initiator: null }, true],
    ["the manager when there is no initiator", { clicker: "UMGR", initiator: null }, true],
    ["a member with no initiator and no lock (never matches null)", { clicker: "UBOB", initiator: null, lockOwner: null }, false],
  ];
  for (const [name, args, want] of cases) {
    test(`${name} -> ${want ? "may decide" : "refused"}`, async () => {
      expect(await canDecidePermission({ ...base, ...args })).toBe(want);
    });
  }

  test("an empty clicker is refused", async () => {
    expect(await canDecidePermission({ ...base, clicker: "", initiator: null })).toBe(false);
  });
});

describe("interimRoleOf", () => {
  test("manager and backup are managers; global and channel approvers are approvers", () => {
    expect(interimRoleOf("default", "UMGR", "CTEAM")).toBe("manager");
    expect(interimRoleOf("default", "UBACKUP", null)).toBe("manager");
    expect(interimRoleOf("default", "UGLOBAL", "CTEAM")).toBe("approver");
    expect(interimRoleOf("default", "UCHANAPP", "CTEAM")).toBe("approver");
    expect(interimRoleOf("default", "UCHANAPP", "COTHER")).toBe("member");
    expect(interimRoleOf("default", "UCHANAPP", null)).toBe("member");
    expect(interimRoleOf("default", "UBOB", "CTEAM")).toBe("member");
  });
});
