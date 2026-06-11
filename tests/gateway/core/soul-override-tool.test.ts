import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "../../../src/db/schema";
import { surfaceTools } from "../../../src/gateway/core/surface-mcp";
import { setSoulData } from "../../../src/soul/extract";
import { SoulDataSchema } from "../../../src/soul/data";
import * as SO from "../../../src/db/soul-overrides";
import type { Surface } from "../../../src/gateway/core/surface";

const fakeSurface: Surface = {
  id: "fake",
  capabilities: new Set() as any,
  reply: async () => ({ ref: "r" }),
  getHistory: async () => ({ messages: [], hasMore: false }),
  requestApproval: async () => ({ approved: true, by: "U0MGR" }),
};

const soul = SoulDataSchema.parse({ manager: { userId: "U0MGR" }, backupManager: { userId: "U0BACKUP" } });

function toolFor(initiator: string | undefined) {
  const defs = surfaceTools(fakeSurface, { initiator: () => initiator });
  const def = defs.find((d) => d.name === "soul_override");
  if (!def) throw new Error("soul_override tool not mounted");
  return def;
}

describe("soul_override MCP tool", () => {
  beforeEach(() => {
    db.run("DELETE FROM soul_overrides");
    setSoulData(soul);
  });

  it("manager-initiated turn mutates the store", async () => {
    const r = await toolFor("U0MGR").handler({ field: "trust", action: "add", value: "C0MCP" });
    expect(JSON.stringify(r)).toContain("C0MCP");
    expect(SO.list()[0]).toMatchObject({ field: "trustedChannels", value: "C0MCP", action: "add" });
  });

  it("non-manager (incl. backup) refused, store untouched", async () => {
    for (const who of ["U0BACKUP", "U0RANDO", undefined]) {
      const r: any = await toolFor(who).handler({ field: "block", action: "add", value: "U0X" });
      expect(r.isError).toBe(true);
    }
    expect(SO.list().length).toBe(0);
  });

  it("list action reports provenance without mutating", async () => {
    SO.upsert({ field: "trustedChannels", value: "C0A", action: "add", created_by: "U0MGR" });
    const r: any = await toolFor("U0MGR").handler({ field: "trust", action: "list" });
    expect(r.content[0].text).toContain("C0A");
    expect(SO.list().length).toBe(1);
  });

  it("not mounted when no initiator resolver provided (legacy callers)", () => {
    const defs = surfaceTools(fakeSurface);
    expect(defs.find((d) => d.name === "soul_override")).toBeUndefined();
  });
});
