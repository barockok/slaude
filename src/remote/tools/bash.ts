import { randomBytes } from "node:crypto";
import { sanitizeKey, shq } from "../shell";
import type { Exec } from "../types";
import { fail, ok, type ToolText } from "./files";

export interface BashCtx {
  exec: Exec;
  root: string;
  sessionKey: string;
  /** Working directory carried between calls (the built-in Bash keeps cwd too). */
  cwd: { value: string };
  /** job id → byte offset already returned by bash_output. */
  bg: Map<string, number>;
}

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const CWD_MARK = "__SLAUDE_CWD__";
const JOB_ID = /^[0-9a-f]{8}$/;

const bgDir = (key: string) => {
  const k = sanitizeKey(key);
  // An empty key would make the dir the parent of every session's jobs.
  if (!k) throw new Error("invalid session key for background jobs");
  return `"$HOME"/.slaude-bg/${k}`;
};

/** Shell: skip (continue) unless $P is a plain decimal pid >= 2 — never `kill -0`, `-1`, or junk. */
const BAD_PID = `case "$P" in ''|*[!0-9]*|0*|1) continue;; esac`;

export async function bashTool(
  ctx: BashCtx,
  i: { command: string; timeout?: number; description?: string; run_in_background?: boolean },
): Promise<ToolText> {
  const enter = `cd ${shq(ctx.cwd.value)} 2>/dev/null || cd ${shq(ctx.root)}`;
  if (i.run_in_background) return startBackground(ctx, enter, i.command);
  const timeoutMs = Math.min(Math.max(1, i.timeout ?? DEFAULT_TIMEOUT), MAX_TIMEOUT);
  // Newline before the trailer so a trailing comment in the command cannot swallow it.
  const cmd = `${enter}\n${i.command}\n__slaude_rc=$?; printf '\\n${CWD_MARK}%s' "$(pwd)"; exit $__slaude_rc`;
  const r = await ctx.exec(cmd, { timeoutMs, login: true });
  let stdout = r.stdout;
  const at = stdout.lastIndexOf(`\n${CWD_MARK}`);
  if (at >= 0) {
    ctx.cwd.value = stdout.slice(at + CWD_MARK.length + 1).trim() || ctx.cwd.value;
    stdout = stdout.slice(0, at);
  }
  const body = [stdout.replace(/\n$/, ""), r.stderr.replace(/\n$/, "")].filter(Boolean).join("\n");
  if (r.timedOut) return { ...fail(`${body}\nCommand timed out after ${timeoutMs}ms`.trim()), exitCode: null };
  if (r.code !== 0) return { ...fail(`Exit code ${r.code}\n${body}`.trim()), exitCode: r.code };
  return { ...ok(body || "(no output)"), exitCode: 0 };
}

async function startBackground(ctx: BashCtx, enter: string, command: string): Promise<ToolText> {
  const id = randomBytes(4).toString("hex");
  const d = bgDir(ctx.sessionKey);
  const inner = `${command}\n__rc=$?; echo $__rc > ${d}/${id}.exit`;
  // Only the `nohup perl …` simple command may be backgrounded: `a && b && c &`
  // would background the whole AND-list, racing mkdir and making $! the
  // subshell's pid instead of the job's process group.
  const cmd =
    `D=${d}; mkdir -p "$D" || exit 2; ${enter} || exit 2; ` +
    `nohup perl -e 'setpgrp(0,0); exec @ARGV' bash -lc ${shq(inner)} > "$D/${id}.log" 2>&1 < /dev/null & ` +
    `echo $! > "$D/${id}.pid"; cat "$D/${id}.pid"`;
  const r = await ctx.exec(cmd, { timeoutMs: 30_000 });
  if (r.code !== 0) return fail(r.stderr.trim() || "could not start background job");
  ctx.bg.set(id, 0);
  return ok(`Command running in background with ID: ${id}. Read its output with mcp__remote__bash_output (bash_id "${id}"); stop it with mcp__remote__bash_kill (shell_id "${id}").`);
}

export async function bashOutputTool(ctx: BashCtx, i: { bash_id: string }): Promise<ToolText> {
  if (!JOB_ID.test(i.bash_id)) return fail(`No background job with ID ${i.bash_id}`);
  const d = bgDir(ctx.sessionKey);
  const off = ctx.bg.get(i.bash_id) ?? 0;
  const cmd =
    `D=${d}; F="$D/${i.bash_id}"; { [ -e "$F.pid" ] || [ -e "$F.killed" ]; } || { echo __NOJOB__ >&2; exit 2; }; ` +
    `tail -c +${off + 1} "$F.log"; printf '\\n__SLAUDE_BG__'; ` +
    // A finished or killed job's pgid may have been reused: never probe it.
    `if [ -e "$F.exit" ]; then printf 'exit:'; cat "$F.exit"; elif [ -e "$F.killed" ]; then echo killed; ` +
    `else P=$(cat "$F.pid" 2>/dev/null); case "$P" in ''|*[!0-9]*|0*|1) echo unknown;; ` +
    `*) if kill -0 -"$P" 2>/dev/null; then echo running; else echo killed; fi;; esac; fi`;
  const r = await ctx.exec(cmd, { timeoutMs: 30_000 });
  if (r.stderr.includes("__NOJOB__")) return fail(`No background job with ID ${i.bash_id}`);
  const at = r.stdout.lastIndexOf("\n__SLAUDE_BG__");
  const output = at >= 0 ? r.stdout.slice(0, at) : r.stdout;
  const state = at >= 0 ? r.stdout.slice(at + "\n__SLAUDE_BG__".length).trim() : "unknown";
  ctx.bg.set(i.bash_id, off + Buffer.byteLength(output, "utf8"));
  const status = state.startsWith("exit:") ? `completed (exit code ${state.slice(5).trim()})` : state;
  return ok(`<status>${status}</status>\n${output || "(no new output)"}`);
}

export async function bashKillTool(ctx: BashCtx, i: { shell_id: string }): Promise<ToolText> {
  if (!JOB_ID.test(i.shell_id)) return fail(`No background job with ID ${i.shell_id}`);
  const d = bgDir(ctx.sessionKey);
  const cmd =
    `D=${d}; F="$D/${i.shell_id}"; [ -e "$F.pid" ] || { echo __NOJOB__ >&2; exit 2; }; P=$(cat "$F.pid" 2>/dev/null); ` +
    // Signal only a valid pid (>= 2) of a job that has not finished (its pgid may be reused).
    `if [ ! -e "$F.exit" ]; then case "$P" in ''|*[!0-9]*|0*|1) :;; ` +
    `*) kill -TERM -"$P" 2>/dev/null; i=0; while [ $i -lt 5 ]; do kill -0 -"$P" 2>/dev/null || break; sleep 1; i=$((i+1)); done; ` +
    `kill -0 -"$P" 2>/dev/null && kill -KILL -"$P" 2>/dev/null;; esac; fi; ` +
    `rm -f "$F.pid"; : > "$F.killed"; exit 0`;
  const r = await ctx.exec(cmd, { timeoutMs: 30_000 });
  if (r.stderr.includes("__NOJOB__")) return fail(`No background job with ID ${i.shell_id}`);
  return ok(`Killed background job ${i.shell_id}`);
}

/** Kill every job this session started and remove its files (spec §5.2). */
export function cleanupCommand(sessionKey: string): string {
  const d = bgDir(sessionKey);
  return (
    `D=${d}; [ -d "$D" ] || exit 0; ` +
    `for f in "$D"/*.pid; do [ -e "$f" ] || continue; [ -e "\${f%.pid}.exit" ] && continue; P=$(cat "$f" 2>/dev/null); ${BAD_PID}; kill -TERM -"$P" 2>/dev/null; done; sleep 2; ` +
    `for f in "$D"/*.pid; do [ -e "$f" ] || continue; [ -e "\${f%.pid}.exit" ] && continue; P=$(cat "$f" 2>/dev/null); ${BAD_PID}; kill -KILL -"$P" 2>/dev/null; done; rm -rf "$D"`
  );
}
