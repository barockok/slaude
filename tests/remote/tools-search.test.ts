import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadState } from "../../src/remote/tools/files";
import { globTool, grepTool } from "../../src/remote/tools/search";
import { localExec } from "./local-exec";

let root: string;
const ctx = () => ({ exec: localExec, root, state: new ReadState() });
const text = (r: any) => r.content.map((c: any) => c.text).join("");

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "slaude-remote-search-"));
  mkdirSync(join(root, "src/lib"), { recursive: true });
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "src/a.ts"), "export const alpha = 1;\n");
  writeFileSync(join(root, "src/lib/b.ts"), "export const Beta = 2;\nconst alpha2 = 3;\n");
  writeFileSync(join(root, "README.md"), "alpha docs\n");
  writeFileSync(join(root, ".git/HEAD"), "alpha in git\n");
  writeFileSync(join(root, "odd name$.ts"), "alpha odd\n");
  utimesSync(join(root, "src/lib/b.ts"), new Date(), new Date(Date.now() + 10_000));
});

describe("glob", () => {
  it("finds nested files, newest first, absolute paths, skipping .git", async () => {
    const out = text(await globTool(ctx(), { pattern: "**/*.ts" })).split("\n");
    expect(out[0]).toBe(join(root, "src/lib/b.ts"));
    expect(out).toContain(join(root, "src/a.ts"));
    expect(out.some((l: string) => l.includes(".git"))).toBe(false);
  });
  it("`**/name` and `dir/**/name` match at every depth, including zero directories", async () => {
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(root, "src/lib/package.json"), "{}\n");
    writeFileSync(join(root, "src/b.ts"), "x\n");
    const pj = text(await globTool(ctx(), { pattern: "**/package.json" })).split("\n");
    expect(pj).toContain(join(root, "package.json"));
    expect(pj).toContain(join(root, "src/lib/package.json"));
    const b = text(await globTool(ctx(), { pattern: "**/b.ts" })).split("\n");
    expect(b).toContain(join(root, "src/b.ts"));
    expect(b).toContain(join(root, "src/lib/b.ts"));
    const sb = text(await globTool(ctx(), { pattern: "src/**/b.ts" })).split("\n");
    expect(sb).toContain(join(root, "src/b.ts"));
    expect(sb).toContain(join(root, "src/lib/b.ts"));
    expect(sb).not.toContain(join(root, "package.json"));
  });
  it("reports no files", async () => {
    expect(text(await globTool(ctx(), { pattern: "**/*.rs" }))).toBe("No files found");
  });
  it("refuses a path outside the root", async () => {
    expect((await globTool(ctx(), { pattern: "*", path: "/etc" })).isError).toBe(true);
  });
});

describe("grep", () => {
  it("files_with_matches by default, skipping .git", async () => {
    const out = text(await grepTool(ctx(), { pattern: "alpha" }));
    expect(out).toContain(join(root, "src/a.ts"));
    expect(out).toContain(join(root, "README.md"));
    expect(out).toContain("odd name$.ts");
    expect(out).not.toContain(".git");
  });
  it("content mode with line numbers and case-insensitive", async () => {
    const out = text(await grepTool(ctx(), { pattern: "beta", output_mode: "content", "-i": true }));
    expect(out).toContain("b.ts:1:export const Beta = 2;");
  });
  it("glob filter and type filter", async () => {
    expect(text(await grepTool(ctx(), { pattern: "alpha", glob: "*.md" }))).not.toContain("a.ts");
    const t = text(await grepTool(ctx(), { pattern: "alpha", type: "ts" }));
    expect(t).toContain("a.ts");
    expect(t).not.toContain("README.md");
  });
  it("count mode", async () => {
    expect(text(await grepTool(ctx(), { pattern: "alpha", output_mode: "count", path: "src" }))).toContain(":1");
  });
  it("head_limit caps output lines", async () => {
    const out = text(await grepTool(ctx(), { pattern: "alpha", head_limit: 1 }));
    expect(out.trim().split("\n").length).toBe(1);
  });
  it("no matches", async () => {
    expect(text(await grepTool(ctx(), { pattern: "zzz_nothing" }))).toBe("No matches found");
  });
  it("a pattern starting with a dash is a pattern, not a flag", async () => {
    writeFileSync(join(root, "dash.txt"), "-rf here\n");
    expect(text(await grepTool(ctx(), { pattern: "-rf" }))).toContain("dash.txt");
  });
});
