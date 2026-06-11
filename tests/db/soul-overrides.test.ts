import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "../../src/db/schema";
import * as SO from "../../src/db/soul-overrides";

describe("soul_overrides db", () => {
  beforeEach(() => db.run("DELETE FROM soul_overrides"));

  it("upserts: latest action for the same (field, value) wins", () => {
    SO.upsert({ field: "trustedChannels", value: "C0NEW", action: "add", created_by: "U0MGR" });
    SO.upsert({ field: "trustedChannels", value: "C0NEW", action: "remove", created_by: "U0MGR" });
    const rows = SO.list();
    expect(rows.length).toBe(1);
    expect(rows[0]!.action).toBe("remove");
    expect(rows[0]!.created_by).toBe("U0MGR");
  });

  it("clear(field) deletes only that field; clear() deletes all", () => {
    SO.upsert({ field: "trustedChannels", value: "C0A", action: "add", created_by: "U0MGR" });
    SO.upsert({ field: "blockedUsers", value: "U0BAD", action: "add", created_by: "U0MGR" });
    SO.clear("trustedChannels");
    expect(SO.list().map((r) => r.field)).toEqual(["blockedUsers"]);
    SO.clear();
    expect(SO.list().length).toBe(0);
  });
});
