import { beforeEach, describe, expect, test } from "bun:test";
import { surfaceTools, createSurfaceMcp, SURFACE_MCP_NAME } from "../src/gateway/core/surface-mcp";
import { setSoulData } from "../src/soul/extract";
import { SoulDataSchema } from "../src/soul/data";
import * as SO from "../src/db/soul-overrides";
import { db } from "../src/db/schema";
import type { Surface, SurfaceCapability } from "../src/gateway/core/surface";

// Complements tests/surface-mcp.test.ts (gating) — exercises every handler's
// success AND failure branch, plus soul_override's clear / missing-value paths.

function fakeSurface(opts: { failing?: boolean } = {}): Surface {
  const boom = async () => { throw new Error("surface offline"); };
  const caps = new Set<SurfaceCapability>(["edit", "react", "upload", "typing"]);
  const s: any = {
    id: "fake",
    capabilities: caps,
    reply: opts.failing ? boom : async () => ({ ref: "R1" }),
    getHistory: opts.failing
      ? boom
      : async () => ({ messages: [{ author: "U9", text: "hi", ref: "1.0" }], hasMore: true }),
    requestApproval: opts.failing ? boom : async () => ({ approved: true, by: "U1" }),
    edit: opts.failing ? boom : async () => {},
    react: opts.failing ? boom : async () => {},
    unreact: opts.failing ? boom : async () => {},
    upload: opts.failing ? boom : async (a: any) => { s.lastUpload = a; },
    typing: opts.failing ? boom : async () => {},
  };
  return s as Surface;
}

function toolOn(surface: Surface, name: string) {
  const def = surfaceTools(surface).find((d) => d.name === name);
  if (!def) throw new Error(`tool ${name} not mounted`);
  return def;
}

describe("surface tool handlers — success paths", () => {
  const surface = fakeSurface();

  test("get_history returns messages + has_more as JSON", async () => {
    const r: any = await toolOn(surface, "get_history").handler({ limit: 5, include_replies: false });
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.has_more).toBe(true);
    expect(parsed.messages[0].author).toBe("U9");
  });

  test("request_approval reports approval with approver mention", async () => {
    const r: any = await toolOn(surface, "request_approval").handler({ summary: "deploy the thing" });
    expect(r.content[0].text).toBe("approved by <@U1>");
  });

  test("request_approval reports denial with note", async () => {
    const denying = fakeSurface();
    (denying as any).requestApproval = async () => ({ approved: false, by: "U2", note: "too risky" });
    const r: any = await toolOn(denying, "request_approval").handler({ summary: "rm -rf" });
    expect(r.content[0].text).toBe("denied by <@U2> (too risky)");
  });

  test("edit / react / unreact / typing report success", async () => {
    expect((await toolOn(surface, "edit").handler({ ref: "R1", text: "v2" }) as any).content[0].text).toBe("edited");
    expect((await toolOn(surface, "react").handler({ name: "eyes" }) as any).content[0].text).toBe("reacted :eyes:");
    expect((await toolOn(surface, "unreact").handler({ name: "eyes" }) as any).content[0].text).toBe("unreacted :eyes:");
    expect((await toolOn(surface, "typing").handler({ on: true }) as any).content[0].text).toBe("typing on");
    expect((await toolOn(surface, "typing").handler({ on: false }) as any).content[0].text).toBe("typing off");
  });

  test("upload maps initial_comment/alt_text onto the Surface call", async () => {
    const r: any = await toolOn(surface, "upload").handler({
      path: "/tmp/x.png", title: "t", initial_comment: "c", alt_text: "a",
    });
    expect(r.content[0].text).toBe("uploaded");
    expect((surface as any).lastUpload).toEqual({ path: "/tmp/x.png", title: "t", comment: "c", altText: "a" });
  });
});

describe("surface tool handlers — failure paths", () => {
  const surface = fakeSurface({ failing: true });

  for (const [name, args] of [
    ["reply", { text: "x" }],
    ["get_history", {}],
    ["request_approval", { summary: "s" }],
    ["edit", { ref: "R1", text: "x" }],
    ["react", { name: "eyes" }],
    ["unreact", { name: "eyes" }],
    ["upload", { path: "/tmp/x" }],
    ["typing", { on: true }],
  ] as const) {
    test(`${name} surfaces the error as isError result`, async () => {
      const r: any = await toolOn(surface, name).handler(args);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("surface offline");
    });
  }
});

describe("soul_override — clear and validation branches", () => {
  const soul = SoulDataSchema.parse({ manager: { userId: "U0MGR" } });

  beforeEach(() => {
    db.run("DELETE FROM soul_overrides");
    setSoulData(soul);
  });

  function overrideTool() {
    const def = surfaceTools(fakeSurface(), { initiator: () => "U0MGR" }).find((d) => d.name === "soul_override");
    if (!def) throw new Error("soul_override not mounted");
    return def;
  }

  test("clear drops only the targeted field's overrides", async () => {
    SO.upsert({ field: "trustedChannels", value: "C0A", action: "add", created_by: "U0MGR" });
    SO.upsert({ field: "blockedUsers", value: "U0BAD", action: "add", created_by: "U0MGR" });
    const r: any = await overrideTool().handler({ field: "trust", action: "clear" });
    expect(r.content[0].text).toBe("cleared runtime overrides for trust");
    expect(SO.list().map((o) => o.field)).toEqual(["blockedUsers"]);
  });

  test("add without value is refused", async () => {
    const r: any = await overrideTool().handler({ field: "trust", action: "add" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("value is required");
  });

  test("remove flows through mutateOverride", async () => {
    SO.upsert({ field: "trustedChannels", value: "C0A", action: "add", created_by: "U0MGR" });
    const r: any = await overrideTool().handler({ field: "trust", action: "remove", value: "C0A" });
    expect(JSON.stringify(r)).toContain("C0A");
  });
});

describe("createSurfaceMcp", () => {
  test("builds the SDK MCP server from the surface's tools", () => {
    const server = createSurfaceMcp(fakeSurface());
    expect(server).toBeDefined();
    expect(SURFACE_MCP_NAME).toBe("slaude_surface");
  });
});
