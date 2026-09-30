import { posix } from "node:path";
import { MTIME, shq } from "../shell";
import type { Exec } from "../types";

export type ToolText = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
  /** Remote exit code, for the audit line only; stripped before returning to the SDK. */
  exitCode?: number | null;
};
export const ok = (text: string): ToolText => ({ content: [{ type: "text", text }] });
export const fail = (text: string): ToolText => ({ content: [{ type: "text", text }], isError: true });

/** path → mtime seen at the last read/write, per session. */
export class ReadState {
  #m = new Map<string, string>();
  get(p: string) { return this.#m.get(p); }
  set(p: string, mtime: string) { this.#m.set(p, mtime); }
}

export interface FileCtx { exec: Exec; root: string; state: ReadState }

const IO_TIMEOUT = 60_000;
const MAX_FILE_CHARS = 10_000_000;
const DEFAULT_LIMIT = 2000;
const MAX_LINE = 2000;
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const UNSUPPORTED = new Set(["pdf", "ipynb"]);

/** Jail to the chosen directory — prevents accidents, not a security boundary (spec §5.3). */
export function resolveRemotePath(root: string, p: string): string {
  const abs = posix.normalize(p.startsWith("/") ? p : posix.join(root, p));
  const rel = posix.relative(root, abs);
  if (rel.startsWith("..") || posix.isAbsolute(rel)) throw new Error(`${p} is outside the remote directory ${root}`);
  return abs;
}

const ext = (p: string) => (p.split(".").pop() ?? "").toLowerCase();

/** `P=...; exists/dir checks; print mtime then a newline, then <body>`. Missing → exit 2 + marker. */
function withFile(path: string, body: string): string {
  return `P=${shq(path)}; if [ ! -e "$P" ]; then echo __ENOENT__ >&2; exit 2; fi; if [ -d "$P" ]; then echo __EISDIR__ >&2; exit 2; fi; ${MTIME} "$P"; printf '\\n'; ${body}`;
}

function splitMtime(stdout: string): { mtime: string; body: string } {
  const i = stdout.indexOf("\n");
  return { mtime: stdout.slice(0, i), body: stdout.slice(i + 1) };
}

function fileError(path: string, stderr: string): string {
  if (stderr.includes("__ENOENT__")) return `File does not exist: ${path}`;
  if (stderr.includes("__EISDIR__")) return `${path} is a directory, not a file`;
  return stderr.trim() || "remote command failed";
}

export async function readTool(ctx: FileCtx, i: { file_path: string; offset?: number; limit?: number }): Promise<ToolText> {
  let path: string;
  try { path = resolveRemotePath(ctx.root, i.file_path); } catch (e) { return fail((e as Error).message); }
  const e = ext(path);
  if (UNSUPPORTED.has(e)) return fail(`Reading .${e} files is not supported in remote mode yet.`);
  if (IMAGE_TYPES[e]) {
    const r = await ctx.exec(withFile(path, `base64 < "$P" | tr -d '\\n'`), { timeoutMs: IO_TIMEOUT, maxOutput: MAX_FILE_CHARS });
    if (r.code !== 0) return fail(fileError(i.file_path, r.stderr));
    if (r.truncated) return fail(`${i.file_path} is too large to read in remote mode.`);
    const { mtime, body } = splitMtime(r.stdout);
    ctx.state.set(path, mtime);
    return { content: [{ type: "image", data: body, mimeType: IMAGE_TYPES[e]! }] };
  }
  const start = Math.max(1, Math.floor(i.offset ?? 1));
  const end = start + Math.max(1, Math.floor(i.limit ?? DEFAULT_LIMIT)) - 1;
  const r = await ctx.exec(withFile(path, `sed -n '${start},${end}p' < "$P"`), { timeoutMs: IO_TIMEOUT });
  if (r.code !== 0) return fail(fileError(i.file_path, r.stderr));
  const { mtime, body } = splitMtime(r.stdout);
  ctx.state.set(path, mtime);
  if (body === "") return ok(start === 1 ? "(file is empty)" : `(no lines at offset ${start})`);
  const lines = body.endsWith("\n") ? body.slice(0, -1).split("\n") : body.split("\n");
  return ok(
    lines
      .map((l, k) => `${String(start + k).padStart(6)}\t${l.length > MAX_LINE ? l.slice(0, MAX_LINE) + "…" : l}`)
      .join("\n") + (r.truncated ? "\n[output truncated]" : ""),
  );
}

/** Write guarded by the mtime seen at read time: "" = must not exist. Prints the new mtime. */
function guardedWrite(path: string, expected: string): string {
  return `P=${shq(path)}; EXP=${shq(expected)}; if [ -e "$P" ]; then M=$(${MTIME} "$P"); [ "$M" = "$EXP" ] || { echo __STALE__ >&2; exit 3; }; fi; mkdir -p "$(dirname "$P")" && cat > "$P" && ${MTIME} "$P"`;
}

function staleMessage(neverRead: boolean): string {
  return neverRead
    ? "File has not been read yet. Read it first before writing to it."
    : "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";
}

export async function writeTool(ctx: FileCtx, i: { file_path: string; content: string }): Promise<ToolText> {
  let path: string;
  try { path = resolveRemotePath(ctx.root, i.file_path); } catch (e) { return fail((e as Error).message); }
  const seen = ctx.state.get(path);
  const r = await ctx.exec(guardedWrite(path, seen ?? ""), { stdin: i.content, timeoutMs: IO_TIMEOUT });
  if (r.stderr.includes("__STALE__")) return fail(staleMessage(seen === undefined));
  if (r.code !== 0) return fail(r.stderr.trim() || "write failed");
  ctx.state.set(path, r.stdout.trim());
  return ok(`File ${seen === undefined ? "created" : "updated"} successfully at: ${path}`);
}

export async function editTool(
  ctx: FileCtx,
  i: { file_path: string; old_string: string; new_string: string; replace_all?: boolean },
): Promise<ToolText> {
  let path: string;
  try { path = resolveRemotePath(ctx.root, i.file_path); } catch (e) { return fail((e as Error).message); }
  const seen = ctx.state.get(path);
  if (seen === undefined) return fail(staleMessage(true));
  if (i.old_string === i.new_string) return fail("No changes to make: old_string and new_string are exactly the same.");
  const r = await ctx.exec(withFile(path, `cat < "$P"`), { timeoutMs: IO_TIMEOUT, maxOutput: MAX_FILE_CHARS });
  if (r.code !== 0) return fail(fileError(i.file_path, r.stderr));
  if (r.truncated) return fail(`${i.file_path} is too large to edit in remote mode.`);
  const { mtime, body } = splitMtime(r.stdout);
  if (mtime !== seen) return fail(staleMessage(false));
  const count = i.old_string === "" ? 0 : body.split(i.old_string).length - 1;
  if (count === 0) return fail(`String to replace not found in file.\nString: ${i.old_string}`);
  if (count > 1 && !i.replace_all) {
    return fail(`Found ${count} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${i.old_string}`);
  }
  const next = i.replace_all ? body.split(i.old_string).join(i.new_string) : body.replace(i.old_string, () => i.new_string);
  const w = await ctx.exec(guardedWrite(path, mtime), { stdin: next, timeoutMs: IO_TIMEOUT });
  if (w.stderr.includes("__STALE__")) return fail(staleMessage(false));
  if (w.code !== 0) return fail(w.stderr.trim() || "edit failed");
  ctx.state.set(path, w.stdout.trim());
  return ok(`The file ${path} has been updated.`);
}
