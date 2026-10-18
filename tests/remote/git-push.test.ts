import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitPushTool } from "../../src/remote/tools/git-push";
import { gitPushGuard, remotePermission } from "../../src/remote/mcp";
import type { Exec } from "../../src/remote/types";

const sh = (cmd: string, cwd: string) => {
  const p = Bun.spawnSync(["sh", "-c", cmd], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: cwd } });
  return { stdout: p.stdout.toString(), stderr: p.stderr.toString(), code: p.exitCode };
};

/** A "remote machine" that is a local directory: same contract as the SSH exec. */
const localExec = (cwd: string): Exec => async (cmd, opts) => {
  const r = sh(cmd, cwd);
  const max = opts.maxOutput ?? 30_000;
  return { ...r, stdout: r.stdout.slice(0, max), truncated: r.stdout.length > max, timedOut: false };
};

let tmp: string, work: string, origin: string;
const text = (r: any): string => r.content.map((c: any) => c.text).join("\n");

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "git-push-test-"));
  work = join(tmp, "work");
  origin = join(tmp, "origin.git");
  sh(`git init -q --bare ${origin}`, tmp);
  sh(
    `git init -q -b main work && cd work && git config user.name Dev && git config user.email dev@x && ` +
      `echo a > a && git add a && git commit -qm base && git switch -qc factory/demo && echo b > b && git add b && git commit -qm "feat: b"`,
    tmp,
  );
  process.env.SLAUDE_GIT_PUSH_REMOTES = origin;
});

afterEach(() => {
  delete process.env.SLAUDE_GIT_PUSH_REMOTES;
  rmSync(tmp, { recursive: true, force: true });
});

describe("git_push", () => {
  it("carries the branch back as a bundle and pushes only refs/heads/factory/<name>", async () => {
    const r = await gitPushTool({ exec: localExec(work), root: work }, { branch: "factory/demo", remote: origin });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain("feat: b");
    const remoteHead = sh(`git --git-dir=${origin} rev-parse refs/heads/factory/demo`, tmp).stdout.trim();
    expect(remoteHead).toBe(sh("git rev-parse factory/demo", work).stdout.trim());
    expect(sh(`git --git-dir=${origin} for-each-ref --format='%(refname)'`, tmp).stdout.trim()).toBe("refs/heads/factory/demo");
  });

  it("a second push of new commits reports only the new ones; no force push", async () => {
    const ctx = { exec: localExec(work), root: work };
    await gitPushTool(ctx, { branch: "factory/demo", remote: origin });
    sh(`echo c > c && git add c && git commit -qm "feat: c"`, work);
    const r = await gitPushTool(ctx, { branch: "factory/demo", remote: origin });
    expect(text(r)).toContain("feat: c");
    expect(text(r)).not.toContain("feat: b");
    sh(`git reset -q --hard HEAD~2 && echo d > d && git add d && git commit -qm rewrite`, work);
    const rejected = await gitPushTool(ctx, { branch: "factory/demo", remote: origin });
    expect(rejected.isError).toBe(true);
  });

  it("refuses branches outside factory/*, remotes off the allowlist, and missing branches", async () => {
    const ctx = { exec: localExec(work), root: work };
    for (const branch of ["main", "factory/", "factory/../main", "refs/heads/factory/x"]) {
      expect((await gitPushTool(ctx, { branch, remote: origin })).isError).toBe(true);
    }
    expect(text(await gitPushTool(ctx, { branch: "factory/demo", remote: "/elsewhere.git" }))).toContain("not allowed");
    expect(text(await gitPushTool(ctx, { branch: "factory/nope", remote: origin }))).toContain("no branch");
    delete process.env.SLAUDE_GIT_PUSH_REMOTES;
    expect(text(await gitPushTool(ctx, { branch: "factory/demo", remote: origin }))).toContain("not configured");
    expect(sh(`git --git-dir=${origin} for-each-ref`, tmp).stdout.trim()).toBe("");
  });

  it("always asks; denied where nobody can be asked; the hook denies it in bypass mode", async () => {
    expect(remotePermission("mcp__remote__git_push", "default")).toBe("ask");
    expect(remotePermission("mcp__remote__git_push", "acceptEdits")).toBe("ask");
    for (const m of ["plan", "dontAsk", "bypassPermissions"]) expect(remotePermission("mcp__remote__git_push", m)).toBe("deny");
    const ev = (tool: string) => ({ hook_event_name: "PreToolUse", tool_name: tool }) as any;
    const sig = { signal: new AbortController().signal };
    const bypass = await gitPushGuard(() => "bypassPermissions")(ev("mcp__remote__git_push"), undefined, sig);
    expect((bypass as any).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(await gitPushGuard(() => "default")(ev("mcp__remote__git_push"), undefined, sig)).toEqual({});
    expect(await gitPushGuard(() => "bypassPermissions")(ev("mcp__remote__bash"), undefined, sig)).toEqual({});
  });
});
