import { describe, expect, test } from "bun:test";
import { canChangeModel } from "../src/gateway/slack/model-auth";
import type { SoulData } from "../src/soul/data";

const soul = {
  manager: { userId: "MGR" },
  backupManager: { userId: "BAK" },
  approvers: [{ userId: "APP" }],
  dmAllowedUsers: ["DM"],
} as unknown as SoulData;

describe("canChangeModel", () => {
  test("manager allowed", () => expect(canChangeModel("MGR", soul)).toBe(true));
  test("backup allowed", () => expect(canChangeModel("BAK", soul)).toBe(true));
  test("approver allowed", () => expect(canChangeModel("APP", soul)).toBe(true));
  test("dm-allowed user allowed", () => expect(canChangeModel("DM", soul)).toBe(true));
  test("stranger denied", () => expect(canChangeModel("X", soul)).toBe(false));
});
