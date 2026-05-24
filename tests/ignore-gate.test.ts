import { describe, expect, test, beforeEach } from "bun:test";
import { db } from "../src/db/schema";
import * as Ignores from "../src/db/ignores";

describe("ignores DB", () => {
  beforeEach(() => {
    db.run("DELETE FROM ignores");
  });

  test("creates and finds active user ignore", () => {
    const now = Date.now();
    Ignores.create({
      targetType: "user",
      userId: "U123",
      createdBy: "U999",
      expiresAt: now + 600_000,
      reason: "testing",
    });
    const active = Ignores.findActiveForUser("U123");
    expect(active).not.toBeNull();
    expect(active?.userId).toBe("U123");
  });

  test("does not find expired user ignore", () => {
    Ignores.create({
      targetType: "user",
      userId: "U123",
      createdBy: "U999",
      expiresAt: Date.now() - 1000,
      reason: "expired",
    });
    expect(Ignores.findActiveForUser("U123")).toBeNull();
  });

  test("finds permanent user ignore (no expiry)", () => {
    Ignores.create({
      targetType: "user",
      userId: "U123",
      createdBy: "U999",
      reason: "permanent",
    });
    const active = Ignores.findActiveForUser("U123");
    expect(active).not.toBeNull();
    expect(active?.expiresAt).toBeNull();
  });

  test("removes user ignore", () => {
    Ignores.create({ targetType: "user", userId: "U123", createdBy: "U999", reason: "x" });
    expect(Ignores.findActiveForUser("U123")).not.toBeNull();
    Ignores.remove({ targetType: "user", userId: "U123" });
    expect(Ignores.findActiveForUser("U123")).toBeNull();
  });

  test("finds active thread ignore", () => {
    Ignores.create({
      targetType: "thread",
      channelId: "C123",
      threadTs: "123.456",
      createdBy: "U999",
      expiresAt: Date.now() + 600_000,
      reason: "testing",
    });
    const active = Ignores.findActiveForThread("C123", "123.456");
    expect(active).not.toBeNull();
  });

  test("cleanupExpired removes only expired records", () => {
    const now = Date.now();
    Ignores.create({ targetType: "user", userId: "U1", createdBy: "U999", expiresAt: now - 1000, reason: "old" });
    Ignores.create({ targetType: "user", userId: "U2", createdBy: "U999", expiresAt: now + 600_000, reason: "new" });
    Ignores.cleanupExpired();
    expect(Ignores.findActiveForUser("U1")).toBeNull();
    expect(Ignores.findActiveForUser("U2")).not.toBeNull();
  });
});
