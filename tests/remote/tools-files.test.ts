import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadState, readTool, writeTool, editTool, resolveRemotePath } from "../../src/remote/tools/files";
import { localExec } from "./local-exec";

let root: string;
let ctx: { exec: typeof localExec; root: string; state: ReadState };
const text = (r: any) => r.content.map((c: any) => c.text ?? "").join("");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "slaude-remote-files-"));
  ctx = { exec: localExec, root, state: new ReadState() };
});

describe("resolveRemotePath", () => {
  it("joins relative paths to root and refuses escapes", () => {
    expect(resolveRemotePath("/r", "a/b.txt")).toBe("/r/a/b.txt");
    expect(resolveRemotePath("/r", "/r/x")).toBe("/r/x");
    expect(() => resolveRemotePath("/r", "../etc/passwd")).toThrow("outside the remote directory");
    expect(() => resolveRemotePath("/r", "/etc/passwd")).toThrow("outside the remote directory");
  });
});

describe("read", () => {
  it("returns cat -n formatted lines with offset/limit", async () => {
    writeFileSync(join(root, "f.txt"), "a\nb\nc\nd\n");
    const r = await readTool(ctx, { file_path: "f.txt", offset: 2, limit: 2 });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe("     2\tb\n     3\tc");
  });
  it("handles hostile file names literally", async () => {
    const name = "a b'$(touch pwned).txt";
    writeFileSync(join(root, name), "safe\n");
    const r = await readTool(ctx, { file_path: name });
    expect(text(r)).toBe("     1\tsafe");
    expect(await Bun.file(join(root, "pwned")).exists()).toBe(false);
  });
  it("reports a missing file as a tool error", async () => {
    const r = await readTool(ctx, { file_path: "nope.txt" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("does not exist");
  });
  it("returns images as image blocks", async () => {
    writeFileSync(join(root, "p.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const r = await readTool(ctx, { file_path: "p.png" });
    expect(r.content[0]).toEqual({ type: "image", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"), mimeType: "image/png" });
  });
  it("rejects pdf in v1", async () => {
    writeFileSync(join(root, "d.pdf"), "%PDF");
    const r = await readTool(ctx, { file_path: "d.pdf" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("not supported in remote mode");
  });
});

describe("write", () => {
  it("creates a new file and parent directories without a prior read", async () => {
    const r = await writeTool(ctx, { file_path: "deep/new.txt", content: "hi\n" });
    expect(r.isError).toBeFalsy();
    expect(readFileSync(join(root, "deep/new.txt"), "utf8")).toBe("hi\n");
  });
  it("refuses to overwrite an existing file that was not read", async () => {
    writeFileSync(join(root, "e.txt"), "old");
    const r = await writeTool(ctx, { file_path: "e.txt", content: "new" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("has not been read yet");
    expect(readFileSync(join(root, "e.txt"), "utf8")).toBe("old");
  });
  it("overwrites after a read", async () => {
    writeFileSync(join(root, "e.txt"), "old");
    await readTool(ctx, { file_path: "e.txt" });
    const r = await writeTool(ctx, { file_path: "e.txt", content: "new" });
    expect(r.isError).toBeFalsy();
    expect(readFileSync(join(root, "e.txt"), "utf8")).toBe("new");
  });
  it("refuses when the file changed after the read (user edited it)", async () => {
    writeFileSync(join(root, "e.txt"), "old");
    await readTool(ctx, { file_path: "e.txt" });
    writeFileSync(join(root, "e.txt"), "user change");
    utimesSync(join(root, "e.txt"), new Date(), new Date(Date.now() + 5000));
    const r = await writeTool(ctx, { file_path: "e.txt", content: "agent" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("modified since read");
    expect(readFileSync(join(root, "e.txt"), "utf8")).toBe("user change");
  });
});

describe("edit", () => {
  beforeEach(async () => {
    writeFileSync(join(root, "c.ts"), "const a = 1;\nconst b = 1;\n");
  });
  it("requires a prior read", async () => {
    const r = await editTool(ctx, { file_path: "c.ts", old_string: "a = 1", new_string: "a = 2" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("has not been read yet");
  });
  it("replaces a unique match", async () => {
    await readTool(ctx, { file_path: "c.ts" });
    const r = await editTool(ctx, { file_path: "c.ts", old_string: "a = 1", new_string: "a = 2" });
    expect(r.isError).toBeFalsy();
    expect(readFileSync(join(root, "c.ts"), "utf8")).toBe("const a = 2;\nconst b = 1;\n");
  });
  it("refuses an ambiguous match unless replace_all", async () => {
    await readTool(ctx, { file_path: "c.ts" });
    const r = await editTool(ctx, { file_path: "c.ts", old_string: "= 1", new_string: "= 3" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Found 2 matches");
    const all = await editTool(ctx, { file_path: "c.ts", old_string: "= 1", new_string: "= 3", replace_all: true });
    expect(all.isError).toBeFalsy();
    expect(readFileSync(join(root, "c.ts"), "utf8")).toBe("const a = 3;\nconst b = 3;\n");
  });
  it("reports a missing string", async () => {
    await readTool(ctx, { file_path: "c.ts" });
    const r = await editTool(ctx, { file_path: "c.ts", old_string: "zzz", new_string: "y" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("not found");
  });
  it("allows two edits in a row (state refreshed after each write)", async () => {
    await readTool(ctx, { file_path: "c.ts" });
    await editTool(ctx, { file_path: "c.ts", old_string: "a = 1", new_string: "a = 2" });
    const r = await editTool(ctx, { file_path: "c.ts", old_string: "b = 1", new_string: "b = 2" });
    expect(r.isError).toBeFalsy();
  });
});
