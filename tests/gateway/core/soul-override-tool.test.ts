import { describe, it, expect, beforeEach } from "bun:test";
import { surfaceTools } from "../../../src/gateway/core/surface-mcp";
import { setSoulData } from "../../../src/soul/extract";
import { SoulDataSchema } from "../../../src/soul/data";
import * as SO from "../../../src/db/soul-overrides";
import { db } from "../../../src/db/schema";
import * as AuditEvents from "../../../src/db/audit-events";
import { flushAudits } from "../../../src/audit/emit";
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
  beforeEach(async () => {
    await SO.clear();
    setSoulData(soul);
  });

  it("manager-initiated turn mutates the store", async () => {
    const r = await toolFor("U0MGR").handler({ field: "trust", action: "add", value: "C0MCP" });
    expect(JSON.stringify(r)).toContain("C0MCP");
    expect((await SO.list())[0]).toMatchObject({ field: "trustedChannels", value: "C0MCP", action: "add" });
  });

  it("non-manager (incl. backup) refused, store untouched", async () => {
    for (const who of ["U0BACKUP", "U0RANDO", undefined]) {
      const r: any = await toolFor(who).handler({ field: "block", action: "add", value: "U0X" });
      expect(r.isError).toBe(true);
    }
    expect((await SO.list()).length).toBe(0);
  });

  it("list action reports provenance without mutating", async () => {
    await SO.upsert({ field: "trustedChannels", value: "C0A", action: "add", created_by: "U0MGR" });
    const r: any = await toolFor("U0MGR").handler({ field: "trust", action: "list" });
    expect(r.content[0].text).toContain("C0A");
    expect((await SO.list()).length).toBe(1);
  });

  it("add and clear record soul.override.set and soul.override.cleared; a refusal records nothing", async () => {
    await db.run("DELETE FROM audit_events");
    await toolFor("U0RANDO").handler({ field: "trust", action: "add", value: "C0NOPE" });
    await toolFor("U0MGR").handler({ field: "trust", action: "add", value: "C0AUD" });
    await toolFor("U0MGR").handler({ field: "trust", action: "clear" });
    await flushAudits();
    const rows = (await AuditEvents.list({ action: "soul.override." })).items;
    expect(rows.map((e) => [e.action, e.actorId, e.targetId]).sort()).toEqual([
      ["soul.override.cleared", "U0MGR", "trustedChannels"],
      ["soul.override.set", "U0MGR", "trustedChannels"],
    ]);
    expect(rows.find((e) => e.action === "soul.override.set")!.details).toMatchObject({ op: "add", value: "C0AUD", via: "agent_tool" });
  });

  it("not mounted when no initiator resolver provided (legacy callers)", () => {
    const defs = surfaceTools(fakeSurface);
    expect(defs.find((d) => d.name === "soul_override")).toBeUndefined();
  });
});
