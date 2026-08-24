import { describe, expect, test, beforeEach } from "bun:test";
import { db } from "../src/db/schema";
import * as Ignores from "../src/db/ignores";
import { IgnoreGate } from "../src/gateway/slack/ignore-gate";

describe("ignores DB", () => {
  beforeEach(async () => {
    await db.run("DELETE FROM ignores");
  });

  test("creates and finds active user ignore", async () => {
    const now = Date.now();
    await Ignores.create({
      targetType: "user",
      userId: "U123",
      createdBy: "U999",
      expiresAt: now + 600_000,
      reason: "testing",
    });
    const active = await Ignores.findActiveForUser("U123");
    expect(active).not.toBeNull();
    expect(active?.userId).toBe("U123");
  });

  test("does not find expired user ignore", async () => {
    await Ignores.create({
      targetType: "user",
      userId: "U123",
      createdBy: "U999",
      expiresAt: Date.now() - 1000,
      reason: "expired",
    });
    expect(await Ignores.findActiveForUser("U123")).toBeNull();
  });

  test("finds permanent user ignore (no expiry)", async () => {
    await Ignores.create({
      targetType: "user",
      userId: "U123",
      createdBy: "U999",
      reason: "permanent",
    });
    const active = await Ignores.findActiveForUser("U123");
    expect(active).not.toBeNull();
    expect(active?.expiresAt).toBeNull();
  });

  test("removes user ignore", async () => {
    await Ignores.create({ targetType: "user", userId: "U123", createdBy: "U999", reason: "x" });
    expect(await Ignores.findActiveForUser("U123")).not.toBeNull();
    await Ignores.remove({ targetType: "user", userId: "U123" });
    expect(await Ignores.findActiveForUser("U123")).toBeNull();
  });

  test("finds active thread ignore", async () => {
    await Ignores.create({
      targetType: "thread",
      channelId: "C123",
      threadTs: "123.456",
      createdBy: "U999",
      expiresAt: Date.now() + 600_000,
      reason: "testing",
    });
    const active = await Ignores.findActiveForThread("C123", "123.456");
    expect(active).not.toBeNull();
  });

  test("cleanupExpired removes only expired records", async () => {
    const now = Date.now();
    await Ignores.create({ targetType: "user", userId: "U1", createdBy: "U999", expiresAt: now - 1000, reason: "old" });
    await Ignores.create({ targetType: "user", userId: "U2", createdBy: "U999", expiresAt: now + 600_000, reason: "new" });
    await Ignores.cleanupExpired();
    expect(await Ignores.findActiveForUser("U1")).toBeNull();
    expect(await Ignores.findActiveForUser("U2")).not.toBeNull();
  });
});

describe("IgnoreGate", () => {
  beforeEach(async () => {
    await db.run("DELETE FROM ignores");
  });

  test("drops message from ignored user", async () => {
    await Ignores.create({ targetType: "user", userId: "U123", createdBy: "U999", reason: "x" });
    const gate = new IgnoreGate();
    expect(await gate.shouldDrop("U123", "C1", "123.456")).toBe(true);
  });

  test("drops message in ignored thread", async () => {
    await Ignores.create({ targetType: "thread", channelId: "C1", threadTs: "123.456", createdBy: "U999", reason: "x" });
    const gate = new IgnoreGate();
    expect(await gate.shouldDrop("U123", "C1", "123.456")).toBe(true);
  });

  test("does not drop normal message", async () => {
    const gate = new IgnoreGate();
    expect(await gate.shouldDrop("U123", "C1", "123.456")).toBe(false);
  });

  test("does not drop after user ignore expires", async () => {
    await Ignores.create({ targetType: "user", userId: "U123", createdBy: "U999", expiresAt: Date.now() - 1000, reason: "x" });
    const gate = new IgnoreGate();
    expect(await gate.shouldDrop("U123", "C1", "123.456")).toBe(false);
  });

  test("removes thread ignore", async () => {
    await Ignores.create({ targetType: "thread", channelId: "C1", threadTs: "123.456", createdBy: "U999", reason: "x" });
    expect(await Ignores.findActiveForThread("C1", "123.456")).not.toBeNull();
    await Ignores.remove({ targetType: "thread", channelId: "C1", threadTs: "123.456" });
    expect(await Ignores.findActiveForThread("C1", "123.456")).toBeNull();
  });
});

describe("IgnoreGate edge cases", () => {
  test("class instantiation and method call", async () => {
    const gate = new IgnoreGate();
    expect(await gate.shouldDrop("U1", "C1", "1.2")).toBe(false);
    expect(typeof IgnoreGate).toBe("function");
  });
});
