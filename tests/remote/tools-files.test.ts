import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadState, readTool, writeTool, editTool, resolveRemotePath } from "../../src/remote/tools/files";
import { MTIME } from "../../src/remote/shell";
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
  it("coerces unusable offset/limit before building the line range", async () => {
    writeFileSync(join(root, "f.txt"), "a\nb\nc\n");
    const all = "     1\ta\n     2\tb\n     3\tc";
    // Non-finite → defaults (offset 1, default limit); finite values are floored.
    for (const [offset, limit] of [[NaN, NaN], [Infinity, Infinity], [-Infinity, -Infinity], [0.5, undefined]] as const) {
      const r = await readTool({ ...ctx, state: new ReadState() }, { file_path: "f.txt", offset, limit });
      expect(r.isError).toBeFalsy();
      expect(text(r)).toBe(all);
    }
    // Finite values below 1 clamp to 1.
    expect(text(await readTool(ctx, { file_path: "f.txt", offset: -3, limit: 0 }))).toBe("     1\ta");
    expect(text(await readTool(ctx, { file_path: "f.txt", offset: 2.9, limit: 1.7 }))).toBe("     2\tb");
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
  it("refuses when the file changed after the read (user edited it)", async () => {
    await readTool(ctx, { file_path: "c.ts" });
    writeFileSync(join(root, "c.ts"), "user change a = 1\n");
    utimesSync(join(root, "c.ts"), new Date(), new Date(Date.now() + 5000));
    const r = await editTool(ctx, { file_path: "c.ts", old_string: "a = 1", new_string: "a = 2" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("modified since read");
    expect(readFileSync(join(root, "c.ts"), "utf8")).toBe("user change a = 1\n");
  });
  it("refuses a file that is not valid UTF-8 and leaves its bytes unchanged", async () => {
    const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x61, 0x0a]); // latin1 "caf\xe9 a\n"
    writeFileSync(join(root, "l.txt"), bytes);
    await readTool(ctx, { file_path: "l.txt" });
    const r = await editTool(ctx, { file_path: "l.txt", old_string: "a", new_string: "b" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("not valid UTF-8");
    expect(Buffer.compare(readFileSync(join(root, "l.txt")), bytes)).toBe(0);
  });
  it("edits valid non-ASCII UTF-8 and preserves the characters", async () => {
    writeFileSync(join(root, "u.txt"), "café € one\n");
    await readTool(ctx, { file_path: "u.txt" });
    const r = await editTool(ctx, { file_path: "u.txt", old_string: "one", new_string: "two" });
    expect(r.isError).toBeFalsy();
    expect(readFileSync(join(root, "u.txt"), "utf8")).toBe("café € two\n");
  });
});

describe("fail closed without an mtime (no perl / stat failure)", () => {
  // Simulates a host where the mtime probe prints nothing.
  const noMtime: typeof localExec = (cmd, opts) => localExec(cmd.split(MTIME).join(":"), opts);
  it("read errors and records no state", async () => {
    writeFileSync(join(root, "e.txt"), "old");
    const bad = { ...ctx, exec: noMtime };
    const r = await readTool(bad, { file_path: "e.txt" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("modification time");
    expect(bad.state.get(join(root, "e.txt"))).toBeUndefined();
  });
  it("image read errors too", async () => {
    writeFileSync(join(root, "p.png"), Buffer.from([0x89, 0x50]));
    const r = await readTool({ ...ctx, exec: noMtime }, { file_path: "p.png" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("modification time");
  });
  it("write of an existing unread file fails closed and leaves it unchanged", async () => {
    writeFileSync(join(root, "e.txt"), "old");
    const r = await writeTool({ ...ctx, exec: noMtime }, { file_path: "e.txt", content: "new" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("modification time");
    expect(readFileSync(join(root, "e.txt"), "utf8")).toBe("old");
  });
  it("write of a new file still works", async () => {
    const r = await writeTool({ ...ctx, exec: noMtime }, { file_path: "fresh.txt", content: "hi" });
    expect(r.isError).toBeFalsy();
    expect(readFileSync(join(root, "fresh.txt"), "utf8")).toBe("hi");
  });
  it("edit errors when the mtime is empty", async () => {
    writeFileSync(join(root, "c.ts"), "const a = 1;\n");
    ctx.state.set(join(root, "c.ts"), "");
    const r = await editTool({ ...ctx, exec: noMtime }, { file_path: "c.ts", old_string: "a = 1", new_string: "a = 2" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("modification time");
    expect(readFileSync(join(root, "c.ts"), "utf8")).toBe("const a = 1;\n");
  });
});
