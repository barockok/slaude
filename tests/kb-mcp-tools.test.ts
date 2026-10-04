import { describe, expect, test, beforeEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { paths, ensureHome } from "../src/config/home";
import {
  createKbMcp,
  KB_MCP_NAME,
  kbHandlers,
} from "../src/knowledge/mcp-tools";
import { clearKbCache, loadKbs } from "../src/knowledge/loader";

beforeEach(() => {
  ensureHome();
  if (existsSync(paths.knowledge)) rmSync(paths.knowledge, { recursive: true, force: true });
  mkdirSync(paths.knowledge, { recursive: true });
  clearKbCache();
});

function seedKb(label: string, readme: string) {
  const dir = join(paths.knowledge, label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), readme);
}

describe("kbHandlers.list_kbs", () => {
  test("returns no-KB message when empty", async () => {
    const r = await kbHandlers.list_kbs();
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toBe("(no knowledge bases available)");
  });

  test("returns JSON array when KBs exist", async () => {
    seedKb("runbooks", "# Runbooks");
    seedKb("cookbook", "---\ndescription: recipes\n---\n\n# Cookbook");
    const r = await kbHandlers.list_kbs();
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0]!.text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
    const labels = parsed.map((e: any) => e.label).sort();
    expect(labels).toEqual(["cookbook", "runbooks"]);
    const cookbook = parsed.find((e: any) => e.label === "cookbook");
    expect(cookbook.description).toBe("recipes");
    expect(cookbook.source).toBe("kb-cookbook");
    const runbooks = parsed.find((e: any) => e.label === "runbooks");
    expect(runbooks.label).toBe("runbooks");
  });

  // WS-C §4.1.4: no disk path or file name reaches the model.
  test("JSON keys are label, description, tags and source; no path", async () => {
    seedKb("x", "# X");
    const r = await kbHandlers.list_kbs();
    const parsed = JSON.parse(r.content[0]!.text);
    expect(Object.keys(parsed[0]).sort()).toEqual(["description", "label", "source", "tags"]);
    expect(r.content[0]!.text).not.toContain(paths.knowledge);
  });

  test("lists only the KBs it is given (the persona's)", async () => {
    seedKb("runbooks", "# Runbooks");
    seedKb("cookbook", "# Cookbook");
    const only = loadKbs().filter((k) => k.label === "cookbook");
    expect(JSON.parse((await kbHandlers.list_kbs(only)).content[0]!.text).map((e: any) => e.label)).toEqual(["cookbook"]);
    expect((await kbHandlers.list_kbs([])).content[0]!.text).toBe("(no knowledge bases available)");
  });
});

describe("kbHandlers.search_kbs", () => {
  test("returns no-KB message when empty", async () => {
    const r = await kbHandlers.search_kbs({ query: "service-a" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toBe("(no knowledge bases available)");
  });

  test("searches only the KBs it is given, and returns no path", async () => {
    seedKb("runbooks", ["---", "description: ops", "tags:", "  - service-a", "---", "# Runbooks"].join("\n"));
    seedKb("cookbook", ["---", "description: ops", "tags:", "  - service-a", "---", "# Cookbook"].join("\n"));
    const only = loadKbs().filter((k) => k.label === "cookbook");
    const r = await kbHandlers.search_kbs({ query: "service-a" }, only);
    expect(JSON.parse(r.content[0]!.text).map((e: any) => e.label)).toEqual(["cookbook"]);
    expect(r.content[0]!.text).not.toContain(paths.knowledge);
  });

  test("matches by tag", async () => {
    seedKb("runbooks", ["---", "description: ops runbooks", "tags:", "  - service-a", "  - grafana", "---", "# Runbooks"].join("\n"));
    seedKb("cookbook", "# Cookbook\n\nRecipes.");
    const r = await kbHandlers.search_kbs({ query: "service-a" });
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0]!.text);
    expect(parsed.length).toBe(1);
    expect(parsed[0]!.label).toBe("runbooks");
  });

  test("matches by label keyword", async () => {
    seedKb("grafana-dashboards", "# Grafana\n\nDashboard docs.");
    seedKb("cookbook", "# Cookbook\n\nRecipes.");
    const r = await kbHandlers.search_kbs({ query: "grafana" });
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0]!.text);
    expect(parsed.length).toBe(1);
    expect(parsed[0]!.label).toBe("grafana-dashboards");
  });

  test("matches by description keyword", async () => {
    seedKb("runbooks", ["---", "description: Grafana alerting rules", "---", "# Runbooks"].join("\n"));
    seedKb("cookbook", "# Cookbook\n\nRecipes.");
    const r = await kbHandlers.search_kbs({ query: "alerting" });
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0]!.text);
    expect(parsed.length).toBe(1);
    expect(parsed[0]!.label).toBe("runbooks");
  });

  test("ranks tag match above label match", async () => {
    seedKb("service-a-docs", ["---", "description: docs", "tags:", "  - service-a", "---", "# Docs"].join("\n"));
    seedKb("service-b-docs", "# Service B\n\nDocs for service b.");
    const r = await kbHandlers.search_kbs({ query: "service-a" });
    const parsed = JSON.parse(r.content[0]!.text);
    expect(parsed[0]!.label).toBe("service-a-docs");
  });

  test("respects limit", async () => {
    seedKb("kb-a", "# A");
    seedKb("kb-b", "# B");
    seedKb("kb-c", "# C");
    const r = await kbHandlers.search_kbs({ query: "kb", limit: 2 });
    const parsed = JSON.parse(r.content[0]!.text);
    expect(parsed.length).toBe(2);
  });

  test("returns no-match message when nothing scores", async () => {
    seedKb("runbooks", "# Runbooks");
    const r = await kbHandlers.search_kbs({ query: "xyz-nonexistent" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toBe("(no matching knowledge bases)");
  });

  test("returns error for empty query after tokenization", async () => {
    seedKb("runbooks", "# Runbooks");
    const r = await kbHandlers.search_kbs({ query: "a" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("query too short");
  });
});

describe("createKbMcp", () => {
  test("returns SDK MCP config with correct name", () => {
    const cfg = createKbMcp();
    expect(cfg.name).toBe(KB_MCP_NAME);
    expect(cfg.name).toBe("slaude_kb");
    expect((cfg as any).type).toBe("sdk");
  });

  test("instance is defined", () => {
    const cfg = createKbMcp();
    expect((cfg as any).instance).toBeDefined();
  });
});
