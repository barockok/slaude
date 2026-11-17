import { env } from "../config/env";
import type { WorkflowThreadRow } from "../db/workflow";
import type { SandboxCallResult } from "../remote/sandbox-call";
import { MAX_COMMIT_CONTENT, type CommitRequest, type CommitResult } from "./types";

/** Single-quote a value for the shell. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The shell script that commits one file in the thread's sandbox. It runs in a subshell, so
 * the sandbox shell's remembered working directory is not changed, and it prints exactly one
 * of `SHA:<sha>`, `SKIP:<why>` or `ERR:<why>` as its last line.
 *
 * The repository is the one checked out on a `factory/*` branch (the branches `git_push`
 * accepts). Idempotency lives in git: the commit carries a `Factory-Request: <id>` trailer, a
 * repeat finds it and returns that sha, and unchanged content returns HEAD. Only the target
 * path is committed, so work the agent has staged is left alone.
 */
export function commitScript(root: string, c: CommitRequest): string {
  const rid = c.requestId.replace(/\./g, "\\.");
  const trailer = `Factory-Request: ${c.requestId}`;
  const b64 = Buffer.from(c.content, "utf8").toString("base64");
  return [
    "(",
    "set -eu",
    `root=${shq(root)}`,
    `repo=""; n=0`,
    `for d in "$root"/*/.git; do`,
    `  [ -e "$d" ] || continue`,
    `  r=$(dirname -- "$d")`,
    `  b=$(git -C "$r" rev-parse --abbrev-ref HEAD 2>/dev/null || true)`,
    `  case "$b" in factory/*) repo="$r"; n=$((n+1));; esac`,
    `done`,
    `if [ "$n" -eq 0 ]; then echo "SKIP:no factory branch"; exit 0; fi`,
    `if [ "$n" -gt 1 ]; then echo "ERR:more than one repository is on a factory branch"; exit 3; fi`,
    `cd "$repo"`,
    `sha=$(git log -1 --format=%H --grep=${shq(`^Factory-Request: ${rid}$`)} || true)`,
    `if [ -n "$sha" ]; then echo "SHA:$sha"; exit 0; fi`,
    `mkdir -p -- "$(dirname -- ${shq(c.path)})"`,
    `printf %s ${shq(b64)} | base64 -d > ${shq(c.path)}`,
    `git add -- ${shq(c.path)}`,
    `if git diff --cached --quiet -- ${shq(c.path)}; then echo "SHA:$(git rev-parse HEAD)"; exit 0; fi`,
    `git commit -q -m ${shq(c.message)} -m ${shq(trailer)} -- ${shq(c.path)}`,
    `echo "SHA:$(git rev-parse HEAD)"`,
    ")",
  ].join("\n");
}

/** Read the script's last result line. Throws when there is none or it is an error. */
export function parseCommitOutput(r: SandboxCallResult): CommitResult {
  const lines = r.text.split("\n").map((l) => l.trim()).filter((l) => /^(SHA|SKIP|ERR):/.test(l));
  const last = lines[lines.length - 1];
  if (!last) throw new Error(`the commit script gave no result${r.ok ? "" : `: ${r.text.slice(0, 200)}`}`);
  if (last.startsWith("SHA:")) {
    const sha = last.slice(4);
    if (!/^[0-9a-f]{7,64}$/.test(sha)) throw new Error("the commit script returned a malformed sha");
    return { sha };
  }
  if (last.startsWith("SKIP:")) return { skipped: last.slice(5) };
  throw new Error(last.slice(4));
}

export interface CommitterDeps {
  /** The thread is in sandbox mode (a sandbox exists or may be created for it). */
  inSandbox(row: WorkflowThreadRow): Promise<boolean>;
  bash(sessionId: string, command: string): Promise<SandboxCallResult>;
  root?: () => string;
}

/**
 * Commit callback for the workflow service. `{ skipped }` when the thread has no sandbox or no
 * repository sits on a factory branch (an early artifact, before any code branch exists).
 * Calls for one run are serialized, so a retry that arrives while the first call still runs
 * waits for it and then finds its trailer instead of committing twice.
 */
export function createCommitter(deps: CommitterDeps): (row: WorkflowThreadRow, c: CommitRequest) => Promise<CommitResult> {
  const tails = new Map<string, Promise<unknown>>();
  return async (row, c) => {
    if (c.content.length > MAX_COMMIT_CONTENT) throw new Error("content is too large");
    const prev = tails.get(row.run_id) ?? Promise.resolve();
    const work = prev.catch(() => {}).then(async (): Promise<CommitResult> => {
      if (!(await deps.inSandbox(row))) return { skipped: "no sandbox" };
      const r = await deps.bash(row.session_id, commitScript((deps.root ?? (() => env.sandbox.root()))(), c));
      return parseCommitOutput(r);
    });
    tails.set(row.run_id, work);
    try {
      return await work;
    } finally {
      if (tails.get(row.run_id) === work) tails.delete(row.run_id);
    }
  };
}
