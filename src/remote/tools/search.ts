import { posix } from "node:path";
import { shq } from "../shell";
import { fail, ok, resolveRemotePath, type FileCtx, type ToolText } from "./files";

const SEARCH_TIMEOUT = 60_000;
const GLOB_LIMIT = 100;

/** Glob → find(1) -path pattern. find's `*` already spans `/`, so `**\/` collapses to nothing. */
function globToFind(pattern: string): string {
  return "./" + pattern.replace(/^\.\//, "").replace(/\*\*\//g, "");
}

export async function globTool(ctx: FileCtx, i: { pattern: string; path?: string }): Promise<ToolText> {
  let base: string;
  try { base = resolveRemotePath(ctx.root, i.path ?? ctx.root); } catch (e) { return fail((e as Error).message); }
  const cmd =
    `cd ${shq(base)} || exit 2; ` +
    `if command -v rg >/dev/null 2>&1; then rg --files --hidden -g '!.git' -g ${shq(i.pattern)}; ` +
    `else find . -type f -not -path '*/.git/*' -path ${shq(globToFind(i.pattern))} | sed 's|^\\./||'; fi ` +
    `| perl -ne 'chomp; my @s = stat $_; print "$s[9]\\t$_\\n"' | sort -rn | head -n ${GLOB_LIMIT} | cut -f2-`;
  const r = await ctx.exec(cmd, { timeoutMs: SEARCH_TIMEOUT });
  if (r.code !== 0 && !r.stdout) return fail(r.stderr.trim() || "glob failed");
  const files = r.stdout.split("\n").filter(Boolean).map((f) => posix.join(base, f));
  return ok(files.length ? files.join("\n") : "No files found");
}

export interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: "content" | "files_with_matches" | "count";
  "-i"?: boolean;
  "-n"?: boolean;
  "-A"?: number;
  "-B"?: number;
  "-C"?: number;
  head_limit?: number;
  multiline?: boolean;
}

/** ripgrep type → grep --include globs, for remotes without rg. */
const TYPE_GLOBS: Record<string, string[]> = {
  ts: ["*.ts", "*.tsx", "*.mts", "*.cts"], js: ["*.js", "*.jsx", "*.mjs", "*.cjs"], py: ["*.py"],
  go: ["*.go"], rust: ["*.rs"], java: ["*.java"], c: ["*.c", "*.h"], cpp: ["*.cpp", "*.cc", "*.hpp", "*.hh"],
  md: ["*.md", "*.markdown"], json: ["*.json"], yaml: ["*.yaml", "*.yml"], sh: ["*.sh", "*.bash"],
  html: ["*.html", "*.htm"], css: ["*.css"], sql: ["*.sql"], rb: ["*.rb"], swift: ["*.swift"], kotlin: ["*.kt", "*.kts"],
};

const num = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined);

function rgArgs(i: GrepInput, base: string): string {
  const mode = i.output_mode ?? "files_with_matches";
  const a = ["rg", "--hidden", "-g", shq("!.git")];
  if (mode === "files_with_matches") a.push("-l");
  if (mode === "count") a.push("-c");
  if (mode === "content" && i["-n"] !== false) a.push("-n");
  if (i["-i"]) a.push("-i");
  for (const f of ["-A", "-B", "-C"] as const) { const v = num(i[f]); if (mode === "content" && v !== undefined) a.push(f, String(v)); }
  if (i.glob) a.push("-g", shq(i.glob));
  if (i.type) a.push("-t", shq(i.type));
  if (i.multiline) a.push("-U", "--multiline-dotall");
  a.push("-e", shq(i.pattern), "--", shq(base));
  return a.join(" ");
}

function grepArgs(i: GrepInput, base: string): string | null {
  const mode = i.output_mode ?? "files_with_matches";
  const a = ["grep", "-rIE", "--exclude-dir=.git"];
  if (mode === "files_with_matches") a.push("-l");
  if (mode === "count") a.push("-c");
  if (mode === "content" && i["-n"] !== false) a.push("-n");
  if (i["-i"]) a.push("-i");
  for (const f of ["-A", "-B", "-C"] as const) { const v = num(i[f]); if (mode === "content" && v !== undefined) a.push(f, String(v)); }
  if (i.glob) a.push(`--include=${shq(i.glob)}`);
  if (i.type) {
    const globs = TYPE_GLOBS[i.type];
    if (!globs) return null;
    for (const g of globs) a.push(`--include=${shq(g)}`);
  }
  a.push("-e", shq(i.pattern), "--", shq(base));
  return a.join(" ");
}

export async function grepTool(ctx: FileCtx, i: GrepInput): Promise<ToolText> {
  let base: string;
  try { base = resolveRemotePath(ctx.root, i.path ?? ctx.root); } catch (e) { return fail((e as Error).message); }
  const rg = rgArgs(i, base);
  const grep = grepArgs(i, base);
  const noRg = i.multiline
    ? `echo __NORG_MULTILINE__ >&2; exit 4`
    : grep === null
      ? `echo __NORG_TYPE__ >&2; exit 4`
      : grep;
  // count mode: drop files with zero matches (grep -c prints them).
  const post = (i.output_mode === "count" ? ` | grep -v ':0$'` : "") + (num(i.head_limit) ? ` | head -n ${num(i.head_limit)}` : "");
  const cmd = `if command -v rg >/dev/null 2>&1; then ${rg}; else ${noRg}; fi${post}`;
  const r = await ctx.exec(cmd, { timeoutMs: 60_000 });
  if (r.stderr.includes("__NORG_MULTILINE__")) return fail("multiline search needs ripgrep (rg) installed on the remote machine.");
  if (r.stderr.includes("__NORG_TYPE__")) return fail(`type "${i.type}" needs ripgrep (rg) on the remote; use the glob parameter instead.`);
  const out = r.stdout.replace(/\n$/, "");
  if (!out) return r.code === 1 || r.code === 0 ? ok("No matches found") : fail(r.stderr.trim() || "grep failed");
  return ok(out + (r.truncated ? "\n[output truncated]" : ""));
}
