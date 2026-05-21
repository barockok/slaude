import { describe, expect, test, beforeEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { paths, ensureHome } from "../src/config/home";
import {
  createKbMcp,
  KB_MCP_NAME,
  kbHandlers,
} from "../src/knowledge/mcp-tools";
import { clearKbCache } from "../src/knowledge/loader";

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
    expect(r.content[0]!.text).toBe("(no knowledge bases installed)");
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
    expect(cookbook.index_file).toBe("README.md");
    expect(typeof cookbook.path).toBe("string");
    const runbooks = parsed.find((e: any) => e.label === "runbooks");
    expect(runbooks.label).toBe("runbooks");
  });

  test("JSON keys match KbEntry shape", async () => {
    seedKb("x", "# X");
    const r = await kbHandlers.list_kbs();
    const parsed = JSON.parse(r.content[0]!.text);
    expect(Object.keys(parsed[0]).sort()).toEqual(["description", "index_file", "label", "path"]);
  });
});

describe("kbHandlers.open_kb", () => {
  test("returns index file contents", async () => {
    seedKb("runbooks", "# Amartha Runbooks\n\nOperational procedures.");
    const r = await kbHandlers.open_kb({ label: "runbooks" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toContain("Amartha Runbooks");
    expect(r.content[0]!.text).toContain("Operational procedures.");
  });

  test("returns error for unknown label", async () => {
    const r = await kbHandlers.open_kb({ label: "nonexistent" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("unknown knowledge base");
    expect(r.content[0]!.text).toContain("nonexistent");
    expect(r.content[0]!.text).toContain("list_kbs");
  });

  test("returns full file content not truncated", async () => {
    const body = "A".repeat(500);
    seedKb("big", body);
    const r = await kbHandlers.open_kb({ label: "big" });
    expect(r.content[0]!.text).toBe(body);
  });

  test("works with index.md fallback", async () => {
    const dir = join(paths.knowledge, "fallback-kb");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.md"), "# Fallback Wiki");
    const r = await kbHandlers.open_kb({ label: "fallback-kb" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toContain("Fallback Wiki");
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
