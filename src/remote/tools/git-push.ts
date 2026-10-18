import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../../config/env";
import { GIT_LOCAL_ARGS, GIT_SAFE_ARGS, gitEnv, localGitEnv } from "../../config/safe-git";
import { shq } from "../shell";
import type { Exec } from "../types";
import { fail, ok, resolveRemotePath, type ToolText } from "./files";

export interface GitPushCtx { exec: Exec; root: string }

/** Only factory branches leave the remote; slaude builds the refspec, the model names the branch. */
const BRANCH = /^factory\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
/** Base64 of the bundle; a larger change is not a factory run. */
const MAX_BUNDLE_B64 = 64 * 1024 * 1024;

function badBranch(b: string): boolean {
  return !BRANCH.test(b) || b.includes("..") || b.includes("//") || b.endsWith("/") || b.endsWith(".lock");
}

/** A remote-facing git call that hangs (a slow Bitbucket, a stuck SSH) is killed after this. */
const REMOTE_GIT_TIMEOUT_MS = 60_000;

async function git(args: string[], o: { cwd: string; remote?: boolean; extraEnv?: Record<string, string> }) {
  const p = Bun.spawn(["git", ...(o.remote ? GIT_SAFE_ARGS : GIT_LOCAL_ARGS), ...args], {
    cwd: o.cwd,
    env: { ...(o.remote ? gitEnv() : localGitEnv()), ...o.extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = o.remote ? setTimeout(() => p.kill(), REMOTE_GIT_TIMEOUT_MS) : undefined;
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    const timedOut = timer !== undefined && code !== 0 && p.killed;
    return { stdout: stdout.trim(), stderr: timedOut ? `timed out after ${REMOTE_GIT_TIMEOUT_MS / 1000}s` : stderr.trim(), code };
  } finally {
    clearTimeout(timer);
  }
}

/** HTTPS credential as git config in the child's env (GIT_CONFIG_*), never on argv.
 *  SSH remotes use whatever key slaude's own environment provides. */
function authEnv(remote: string): Record<string, string> {
  const token = env.gitPush.token();
  if (!token || !remote.startsWith("https://")) return {};
  const basic = Buffer.from(`${env.gitPush.tokenUser()}:${token}`).toString("base64");
  return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` };
}

/**
 * Publish a branch from the remote machine without giving it a credential:
 * bundle it there, carry the bundle back over exec, fetch it into a throwaway
 * bare repo here, and push only refs/heads/<branch> (no force) to an allowed remote.
 * ponytail: commits are reported, not checked against the requester; enforce
 * author/committer/trailers here when factory runs carry a requester identity.
 */
export async function gitPushTool(c: GitPushCtx, i: { branch: string; remote: string; dir?: string }): Promise<ToolText> {
  if (badBranch(i.branch)) return fail(`branch must look like factory/<name>; got ${i.branch}`);
  const allowed = env.gitPush.remotes();
  if (allowed.length === 0) return fail("git_push is not configured on this deployment (SLAUDE_GIT_PUSH_REMOTES is empty).");
  if (!allowed.includes(i.remote)) return fail(`remote is not allowed. Allowed remotes:\n${allowed.join("\n")}`);
  let dir: string;
  try {
    dir = resolveRemotePath(c.root, i.dir ?? ".");
  } catch (e) {
    return fail((e as Error).message);
  }
  const ref = `refs/heads/${i.branch}`;

  const head = await c.exec(`cd ${shq(dir)} && git rev-parse --verify --quiet ${shq(`${ref}^{commit}`)}`, { timeoutMs: 30_000 });
  const sha = head.stdout.trim();
  if (head.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) {
    return fail(`no branch ${i.branch} in ${dir}. Commit on that branch first (git switch -c ${i.branch}).`);
  }
  const bundle = await c.exec(
    `cd ${shq(dir)} && t=$(mktemp) && git bundle create -q "$t" ${shq(ref)} && base64 < "$t" | tr -d '\\n'; s=$?; rm -f "$t"; exit $s`,
    { timeoutMs: 300_000, maxOutput: MAX_BUNDLE_B64 },
  );
  if (bundle.truncated) return fail("the branch is too large to carry back as a bundle.");
  if (bundle.code !== 0 || !bundle.stdout) return fail(`git bundle failed on the remote: ${bundle.stderr.trim() || `exit ${bundle.code}`}`);

  const tmp = await mkdtemp(join(tmpdir(), "slaude-git-push-"));
  try {
    const file = join(tmp, "in.bundle");
    await writeFile(file, Buffer.from(bundle.stdout, "base64"));
    const repo = join(tmp, "repo.git");
    let r = await git(["init", "-q", "--bare", repo], { cwd: tmp });
    if (r.code !== 0) return fail(`git init failed: ${r.stderr}`);
    r = await git(["fetch", "-q", file, `${ref}:${ref}`], { cwd: repo });
    if (r.code !== 0) return fail(`the bundle from the remote did not fetch: ${r.stderr}`);
    r = await git(["rev-parse", ref], { cwd: repo });
    if (r.stdout !== sha) return fail("the bundle does not match the branch head on the remote; nothing was pushed.");

    const auth = authEnv(i.remote);
    // Only the target branch is fetched (the bundle already holds its history, so this moves
    // little or nothing). Best effort: a missing branch or unreachable remote only means every
    // commit counts as new. Fetching every branch here was a full clone of the repo per push.
    const target = `refs/remotes/target/${i.branch}`;
    const known = (await git(["fetch", "-q", i.remote, `+${ref}:${target}`], { cwd: repo, remote: true, extraEnv: auth })).code === 0;
    const log = await git(["log", "--format=%h %an <%ae> (committer %cn) %s", ref, ...(known ? ["--not", target] : [])], { cwd: repo });

    r = await git(["push", "--porcelain", i.remote, `${ref}:${ref}`], { cwd: repo, remote: true, extraEnv: auth });
    if (r.code !== 0) return fail(`push rejected or failed (no force push is attempted):\n${r.stderr || r.stdout}`);
    return ok(`Pushed ${i.branch} (${sha.slice(0, 12)}) to ${i.remote}.\nNew commits:\n${log.stdout || "(none; the remote already had them)"}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
