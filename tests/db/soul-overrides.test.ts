import { describe, it, expect, beforeEach } from "bun:test";
import * as SO from "../../src/db/soul-overrides";

describe("soul_overrides db", async () => {
  beforeEach(async () => { await SO.clear(); });

  it("upserts: latest action for the same (field, value) wins", async () => {
    await SO.upsert({ field: "trustedChannels", value: "C0NEW", action: "add", created_by: "U0MGR" });
    await SO.upsert({ field: "trustedChannels", value: "C0NEW", action: "remove", created_by: "U0MGR" });
    const rows = await SO.list();
    expect(rows.length).toBe(1);
    expect(rows[0]!.action).toBe("remove");
    expect(rows[0]!.created_by).toBe("U0MGR");
  });

  it("clear(field) deletes only that field; clear() deletes all", async () => {
    await SO.upsert({ field: "trustedChannels", value: "C0A", action: "add", created_by: "U0MGR" });
    await SO.upsert({ field: "blockedUsers", value: "U0BAD", action: "add", created_by: "U0MGR" });
    await SO.clear("trustedChannels");
    expect((await SO.list()).map((r) => r.field)).toEqual(["blockedUsers"]);
    await SO.clear();
    expect((await SO.list()).length).toBe(0);
  });
});
