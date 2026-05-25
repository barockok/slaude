import { describe, expect, test, beforeEach } from "bun:test";
import { db } from "../src/db/schema";
import * as Ignores from "../src/db/ignores";
import { IgnoreGate } from "../src/gateway/slack/ignore-gate";

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

describe("IgnoreGate", () => {
  beforeEach(() => {
    db.run("DELETE FROM ignores");
  });

  test("drops message from ignored user", () => {
    Ignores.create({ targetType: "user", userId: "U123", createdBy: "U999", reason: "x" });
    const gate = new IgnoreGate();
    expect(gate.shouldDrop("U123", "C1", "123.456")).toBe(true);
  });

  test("drops message in ignored thread", () => {
    Ignores.create({ targetType: "thread", channelId: "C1", threadTs: "123.456", createdBy: "U999", reason: "x" });
    const gate = new IgnoreGate();
    expect(gate.shouldDrop("U123", "C1", "123.456")).toBe(true);
  });

  test("does not drop normal message", () => {
    const gate = new IgnoreGate();
    expect(gate.shouldDrop("U123", "C1", "123.456")).toBe(false);
  });

  test("does not drop after user ignore expires", () => {
    Ignores.create({ targetType: "user", userId: "U123", createdBy: "U999", expiresAt: Date.now() - 1000, reason: "x" });
    const gate = new IgnoreGate();
    expect(gate.shouldDrop("U123", "C1", "123.456")).toBe(false);
  });

  test("removes thread ignore", () => {
    Ignores.create({ targetType: "thread", channelId: "C1", threadTs: "123.456", createdBy: "U999", reason: "x" });
    expect(Ignores.findActiveForThread("C1", "123.456")).not.toBeNull();
    Ignores.remove({ targetType: "thread", channelId: "C1", threadTs: "123.456" });
    expect(Ignores.findActiveForThread("C1", "123.456")).toBeNull();
  });
});

describe("IgnoreGate edge cases", () => {
  test("class instantiation and method call", () => {
    const gate = new IgnoreGate();
    expect(gate.shouldDrop("U1", "C1", "1.2")).toBe(false);
    expect(typeof IgnoreGate).toBe("function");
  });
});
