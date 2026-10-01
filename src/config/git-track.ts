import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * gbrain 0.46+ rejects --path sources that aren't a git repo with committed,
 * tracked content — its sync walker reads through git objects, not the raw
 * filesystem, so an uncommitted file is invisible to it. slaude writes KB
 * content into place via plain file copy in a few spots (install.ts's clone
 * staging + fan-out, sync-manifest's sparse-checkout promotion), which never
 * leaves a `.git` behind. Call this right after writing into such a
 * directory so gbrain's addSource/sync accepts it and later content changes
 * actually get picked up (idempotent — a no-op once nothing is unstaged).
 */
export function ensureGitTracked(dir: string): void {
  if (!existsSync(join(dir, ".git"))) {
    execSync("git init -q", { cwd: dir, stdio: "pipe" });
  }
  execSync("git add -A", { cwd: dir, stdio: "pipe" });
  try {
    execSync("git diff --cached --quiet", { cwd: dir, stdio: "pipe" });
    return; // nothing staged — already committed
  } catch {
    // diff --cached --quiet exits non-zero when there ARE staged changes
  }
  execSync('git -c user.email=slaude@localhost -c user.name=slaude commit -q -m "sync knowledge content"', {
    cwd: dir,
    stdio: "pipe",
  });
}
