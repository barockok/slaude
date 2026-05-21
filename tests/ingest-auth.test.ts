import { describe, test, expect } from "bun:test";
import { canTriggerIngest } from "../src/gateway/slack/ingest-auth";

describe("canTriggerIngest", () => {
  test("allows manager", () => {
    const soul = { manager: { userId: "U_MGR" }, backupManager: null, approvers: [] };
    expect(canTriggerIngest("U_MGR", soul as any)).toBe(true);
  });

  test("allows backup manager", () => {
    const soul = { manager: { userId: "U_MGR" }, backupManager: { userId: "U_BKP" }, approvers: [] };
    expect(canTriggerIngest("U_BKP", soul as any)).toBe(true);
  });

  test("allows approver", () => {
    const soul = {
      manager: { userId: "U_MGR" },
      backupManager: null,
      approvers: [{ userId: "U_APP", scope: "anything" }],
    };
    expect(canTriggerIngest("U_APP", soul as any)).toBe(true);
  });

  test("denies anyone else", () => {
    const soul = { manager: { userId: "U_MGR" }, backupManager: null, approvers: [] };
    expect(canTriggerIngest("U_RANDOM", soul as any)).toBe(false);
  });

  test("denies when soul has no manager", () => {
    const soul = { manager: null, backupManager: null, approvers: [] };
    expect(canTriggerIngest("U_ANY", soul as any)).toBe(false);
  });
});
