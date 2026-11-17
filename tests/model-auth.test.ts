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
  test("manager allowed", async () => expect((await canChangeModel("MGR", soul))).toBe(true));
  test("backup allowed", async () => expect((await canChangeModel("BAK", soul))).toBe(true));
  test("approver allowed", async () => expect((await canChangeModel("APP", soul))).toBe(true));
  test("dm-allowed user allowed", async () => expect((await canChangeModel("DM", soul))).toBe(true));
  test("stranger denied", async () => expect((await canChangeModel("X", soul))).toBe(false));
});
