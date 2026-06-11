import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "../src/db/schema";
import { SoulDataSchema } from "../src/soul/data";
import { applyOverrides, mutateOverride, FIELD_ALIASES } from "../src/soul/overrides";
import * as SO from "../src/db/soul-overrides";

const base = SoulDataSchema.parse({
  manager: { userId: "U0MGR" },
  trustedChannels: ["C0TEAM"],
  allowedChannels: ["C0PUB"],
});

describe("applyOverrides", () => {
  it("add unions, remove shadows a SOUL.md entry", () => {
    const out = applyOverrides(base, [
      { field: "trustedChannels", value: "C0NEW", action: "add", created_by: "U0MGR", created_at: 1 },
      { field: "allowedChannels", value: "C0PUB", action: "remove", created_by: "U0MGR", created_at: 2 },
      { field: "dmAllowedUsers", value: "U0FRIEND", action: "add", created_by: "U0MGR", created_at: 3 },
    ]);
    expect(out.trustedChannels.sort()).toEqual(["C0NEW", "C0TEAM"]);
    expect(out.allowedChannels).toEqual([]);
    expect(out.dmAllowedUsers).toEqual(["U0FRIEND"]);
    // base untouched (pure)
    expect(base.allowedChannels).toEqual(["C0PUB"]);
  });

  it("duplicate add of a SOUL.md entry stays deduped", () => {
    const out = applyOverrides(base, [
      { field: "trustedChannels", value: "C0TEAM", action: "add", created_by: "U0MGR", created_at: 1 },
    ]);
    expect(out.trustedChannels).toEqual(["C0TEAM"]);
  });

  it("no rows → same reference (no copy cost)", () => {
    expect(applyOverrides(base, [])).toBe(base);
  });
});

describe("mutateOverride", () => {
  beforeEach(() => db.run("DELETE FROM soul_overrides"));

  it("accepts alias fields and strips Slack wrappers", () => {
    const r = mutateOverride(
      { field: "trust", action: "add", value: "<#C0WRAP|general>", by: "U0MGR" },
      { managerId: "U0MGR" },
    );
    expect(r.ok).toBe(true);
    expect(SO.list()[0]).toMatchObject({ field: "trustedChannels", value: "C0WRAP", action: "add" });
  });

  it("rejects malformed ids per field type", () => {
    const r1 = mutateOverride({ field: "trust", action: "add", value: "U0NOTCHANNEL", by: "U0MGR" }, { managerId: "U0MGR" });
    expect(r1.ok).toBe(false);
    const r2 = mutateOverride({ field: "dm", action: "add", value: "C0NOTUSER", by: "U0MGR" }, { managerId: "U0MGR" });
    expect(r2.ok).toBe(false);
    expect(SO.list().length).toBe(0);
  });

  it("refuses to block the manager (self-lockout guard)", () => {
    const r = mutateOverride({ field: "block", action: "add", value: "<@U0MGR>", by: "U0MGR" }, { managerId: "U0MGR" });
    expect(r.ok).toBe(false);
    expect(SO.list().length).toBe(0);
  });
});

describe("FIELD_ALIASES", () => {
  it("maps all four command nouns", () => {
    expect(FIELD_ALIASES).toEqual({
      trust: "trustedChannels",
      allow: "allowedChannels",
      dm: "dmAllowedUsers",
      block: "blockedUsers",
    });
  });
});
