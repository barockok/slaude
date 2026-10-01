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

/**
 * Shell function `own PGID JOBID`: is process group PGID still this job's?
 *   0 = ours and alive, 1 = gone, 2 = the pid was reused by an unrelated process.
 * The job's `bash -lc` carries `slaude-job-<id>` as $0. A group whose leader is dead but
 * which is still alive (orphaned children) is ours: a pid cannot be reused while it is
 * still the pgid of a live group. A zombie leader has no argv left (and holds its pid, so
 * it cannot have been reused): treat it as gone. If `ps` shows nothing yet the pid exists,
 * ps is unusable: fail closed. Every kill site calls this before signalling.
 */
const OWN =
  `own() { OC=$(ps -ww -o stat=,command= -p "$1" 2>/dev/null); ` +
  `if [ -n "$OC" ]; then OS=\${OC#"\${OC%%[! ]*}"}; case "$OS" in Z*) :;; ` +
  `*) case "$OC" in *"slaude-job-$2"*) return 0;; *) return 2;; esac;; esac; ` +
  `elif kill -0 "$1" 2>/dev/null; then return 2; fi; ` +
  `if kill -0 -"$1" 2>/dev/null; then return 0; fi; return 1; }; `;

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
  // Two statements on purpose: a lone command would let bash exec it and drop the
  // `slaude-job-<id>` marker (its $0) that the kill sites use to prove ownership.
  const inner = `${command}\n__rc=$?; echo $__rc > ${d}/${id}.exit`;
  // Only the `nohup perl …` simple command may be backgrounded: `a && b && c &`
  // would background the whole AND-list, racing mkdir and making $! the
  // subshell's pid instead of the job's process group.
  const cmd =
    `D=${d}; mkdir -p "$D" || exit 2; ${enter} || exit 2; ` +
    `nohup perl -e 'setpgrp(0,0); exec @ARGV' bash -lc ${shq(inner)} slaude-job-${id} > "$D/${id}.log" 2>&1 < /dev/null & ` +
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
    `${OWN}D=${d}; F="$D/${i.bash_id}"; { [ -e "$F.pid" ] || [ -e "$F.killed" ]; } || { echo __NOJOB__ >&2; exit 2; }; ` +
    `tail -c +${off + 1} "$F.log"; printf '\\n__SLAUDE_BG__'; ` +
    // R: 0 group alive and ours, 1 gone, 2 pid junk or reused by another process (read-only: bash_kill cleans up).
    `R=1; if [ ! -e "$F.killed" ]; then P=$(cat "$F.pid" 2>/dev/null); ` +
    `case "$P" in ''|*[!0-9]*|0*|1) R=2;; *) own "$P" ${i.bash_id}; R=$?;; esac; fi; ` +
    `if [ -e "$F.exit" ]; then printf 'exit:%s' "$(cat "$F.exit")"; [ "$R" = 0 ] && printf ':children'; echo; ` +
    `elif [ "$R" = 2 ]; then echo 'unknown (pid no longer belongs to this job)'; elif [ "$R" = 0 ]; then echo running; else echo killed; fi`;
  const r = await ctx.exec(cmd, { timeoutMs: 30_000 });
  if (r.stderr.includes("__NOJOB__")) return fail(`No background job with ID ${i.bash_id}`);
  const at = r.stdout.lastIndexOf("\n__SLAUDE_BG__");
  const output = at >= 0 ? r.stdout.slice(0, at) : r.stdout;
  const state = at >= 0 ? r.stdout.slice(at + "\n__SLAUDE_BG__".length).trim() : "unknown";
  ctx.bg.set(i.bash_id, off + Buffer.byteLength(output, "utf8"));
  const done = state.match(/^exit:(.*?)(:children)?$/s);
  const status = done
    ? `completed (exit code ${done[1]!.trim()})${done[2] ? "; background child processes are still running" : ""}`
    : state;
  return ok(`<status>${status}</status>\n${output || "(no new output)"}`);
}

export async function bashKillTool(ctx: BashCtx, i: { shell_id: string }): Promise<ToolText> {
  if (!JOB_ID.test(i.shell_id)) return fail(`No background job with ID ${i.shell_id}`);
  const d = bgDir(ctx.sessionKey);
  const cmd =
    `${OWN}D=${d}; F="$D/${i.shell_id}"; [ -e "$F.pid" ] || { echo __NOJOB__ >&2; exit 2; }; P=$(cat "$F.pid" 2>/dev/null); ` +
    // Signal only a valid pid (>= 2) whose group is still this job's (see OWN).
    `R=2; case "$P" in ''|*[!0-9]*|0*|1) :;; *) own "$P" ${i.shell_id}; R=$?;; esac; ` +
    `if [ "$R" = 0 ]; then kill -TERM -"$P" 2>/dev/null; i=0; while [ $i -lt 5 ]; do kill -0 -"$P" 2>/dev/null || break; sleep 1; i=$((i+1)); done; ` +
    `kill -0 -"$P" 2>/dev/null && kill -KILL -"$P" 2>/dev/null; fi; ` +
    `[ "$R" = 2 ] && echo __REUSED__ >&2; rm -f "$F.pid"; : > "$F.killed"; exit 0`;
  const r = await ctx.exec(cmd, { timeoutMs: 30_000 });
  if (r.stderr.includes("__NOJOB__")) return fail(`No background job with ID ${i.shell_id}`);
  if (r.stderr.includes("__REUSED__")) return ok(`Nothing was signalled: the pid no longer belongs to background job ${i.shell_id}.`);
  return ok(`Killed background job ${i.shell_id}`);
}

/** Kill every job this session started and remove its files (spec §5.2). */
export function cleanupCommand(sessionKey: string): string {
  const d = bgDir(sessionKey);
  return (
    `${OWN}D=${d}; [ -d "$D" ] || exit 0; ` +
    `for f in "$D"/*.pid; do [ -e "$f" ] || continue; b=\${f##*/}; P=$(cat "$f" 2>/dev/null); ${BAD_PID}; own "$P" "\${b%.pid}" && kill -TERM -"$P" 2>/dev/null; done; sleep 2; ` +
    `for f in "$D"/*.pid; do [ -e "$f" ] || continue; b=\${f##*/}; P=$(cat "$f" 2>/dev/null); ${BAD_PID}; own "$P" "\${b%.pid}" && kill -KILL -"$P" 2>/dev/null; done; rm -rf "$D"`
  );
}
