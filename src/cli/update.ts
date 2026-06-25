// src/cli/update.ts
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  REPO, distPaths, currentVersion, previousVersion,
  resolveLatestVersion, verifyChecksum, swapCurrent, pruneVersions,
  type FetchLike,
} from "./dist";

type Out = (s: string) => void;
type Env = { SLAUDE_DIST?: string; SLAUDE_BIN_DIR?: string; HOME?: string; SLAUDE_VERSION?: string };
const KEEP = 3;
const log: Out = (s) => process.stdout.write(s + "\n");

export function runRollback(env: Env = process.env as Env, out: Out = log): number {
  const { root } = distPaths(env);
  const prev = previousVersion(root);
  if (!prev) { out("no previous version to roll back to"); return 1; }
  swapCurrent(root, prev);
  out(`rolled back to ${prev}`);
  return 0;
}

export async function runVersion(env: Env = process.env as Env, out: Out = log, fetchImpl: FetchLike = fetch): Promise<number> {
  const { root } = distPaths(env);
  const active = currentVersion(root) ?? "(none)";
  let latest = "(unknown)";
  try { latest = await resolveLatestVersion(fetchImpl); } catch { /* offline: report unknown */ }
  out(`slaude ${active} (latest: ${latest})`);
  if (latest !== "(unknown)" && active !== latest) out(`update available: run \`slaude update\``);
  return 0;
}

type RunCmd = (cmd: string, args: string[], cwd?: string) => void;
const realRun: RunCmd = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}`);
};

export interface InstallDeps { root: string; fetchImpl?: FetchLike; run?: RunCmd; out?: Out; }

export async function installVersion(version: string, deps: InstallDeps): Promise<void> {
  const { root } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const run = deps.run ?? realRun;
  const out = deps.out ?? log;
  const base = `https://github.com/${REPO}/releases/download/v${version}`;
  const tarName = `slaude-${version}.tar.gz`;

  const stage = mkdtempSync(join(tmpdir(), "slaude-dl-"));
  try {
    const tarBytes = new Uint8Array(await (await fetchImpl(`${base}/${tarName}`) as any).arrayBuffer());
    const sumsText = await (await fetchImpl(`${base}/sha256sums.txt`) as any).text();
    if (!verifyChecksum(tarBytes, sumsText, tarName)) throw new Error("checksum verification failed — aborting");

    const tarPath = join(stage, tarName);
    writeFileSync(tarPath, tarBytes);
    const dest = join(root, version);
    mkdirSync(dest, { recursive: true });
    try {
      // tarball root is slaude-<version>/ — strip it.
      run("tar", ["-xzf", tarPath, "-C", dest, "--strip-components=1"]);
      run("bun", ["install", "--frozen-lockfile"], dest);
    } catch (e) {
      rmSync(dest, { recursive: true, force: true }); // don't leave a half-extracted version dir
      throw e;
    }

    swapCurrent(root, version);           // only flip after a clean install
    const pruned = pruneVersions(root, KEEP);
    out(`installed ${version}${pruned.length ? ` (pruned ${pruned.join(", ")})` : ""}`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export async function runUpdate(env: Env = process.env as Env, out: Out = log, deps?: Partial<InstallDeps> & { fetchImpl?: FetchLike }): Promise<number> {
  const { root } = distPaths(env);
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const target = env.SLAUDE_VERSION?.trim() || (await resolveLatestVersion(fetchImpl));
  if (target === currentVersion(root)) { out(`already on ${target}`); return 0; }
  out(`updating to ${target} …`);
  try {
    await installVersion(target, { root, fetchImpl, run: deps?.run, out });
  } catch (e: any) {
    out(`update failed: ${e?.message ?? e}`);
    return 1;
  }
  return 0;
}
