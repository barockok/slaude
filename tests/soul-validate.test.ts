import { describe, test, expect } from "bun:test";
import { validateSoul } from "../src/soul/validate";
import { SoulDataSchema } from "../src/soul/data";

const baseFull = () =>
  SoulDataSchema.parse({
    identity: { name: "slaude", role: "engineer", voice: "terse" },
    manager: { userId: "U0YYYYYYYYY", handle: "@zid" },
    allowedChannels: ["C0AKND0UK4Y"],
    approvers: [{ userId: "U0YYYYYYYYY", scope: "anything", catchall: true }],
    mandate: "help the team ship",
    values: [],
  });

describe("validateSoul", () => {
  test("ok when all required fields present", () => {
    const r = validateSoul(baseFull());
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  test("missing identity.name", () => {
    const d = baseFull();
    d.identity.name = undefined;
    const r = validateSoul(d);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("identity.name");
  });

  test("missing manager.userId", () => {
    const d = baseFull();
    d.manager.userId = undefined;
    const r = validateSoul(d);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("manager.userId");
  });

  test("missing mandate", () => {
    const d = baseFull();
    d.mandate = undefined;
    const r = validateSoul(d);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("mandate");
  });

  test("whitespace-only fields count as missing", () => {
    const d = baseFull();
    d.identity.name = "   ";
    d.mandate = "\n";
    const r = validateSoul(d);
    expect(r.missing).toContain("identity.name");
    expect(r.missing).toContain("mandate");
  });

  test("warns when approvers empty", () => {
    const d = SoulDataSchema.parse({
      identity: { name: "x" },
      manager: { userId: "U0YYYYYYYYY" },
      mandate: "x",
    });
    const r = validateSoul(d);
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes("approvers"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("allowedChannels"))).toBe(true);
  });

  test("warns when backupManager duplicates manager", () => {
    const d = SoulDataSchema.parse({
      identity: { name: "x" },
      manager: { userId: "U0YYYYYYYYY" },
      backupManager: { userId: "U0YYYYYYYYY" },
      mandate: "x",
      allowedChannels: ["C0123456789"],
      approvers: [{ userId: "U0YYYYYYYYY", scope: "any", catchall: true }],
    });
    const r = validateSoul(d);
    expect(r.warnings.some((w) => w.includes("backup is redundant"))).toBe(true);
  });

  test("warns on invalid redactPatterns regex", () => {
    const d = SoulDataSchema.parse({
      identity: { name: "x" },
      manager: { userId: "U0YYYYYYYYY" },
      mandate: "x",
      redactPatterns: ["[unclosed", "good\\w+"],
    });
    const r = validateSoul(d);
    expect(r.warnings.some((w) => w.includes("invalid regex"))).toBe(true);
  });

  test("all three missing surfaces all three", () => {
    const empty = SoulDataSchema.parse({});
    const r = validateSoul(empty);
    expect(r.missing).toEqual([
      "identity.name",
      "manager.userId",
      "mandate",
    ]);
  });
});
