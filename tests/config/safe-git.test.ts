/**
 * The git commands slaude runs itself never execute a hook or fsmonitor
 * command planted in the repository (or in a template a clone copies), and
 * run without the gateway's secrets in their environment
 * (src/config/safe-git.ts).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv, localGitEnv } from "../../src/config/safe-git";
import { ensureGitRepo } from "../../src/knowledge/brain-sync";
import { pushToRepo, pushKbRaw } from "../../src/skills/sync-manifest";
import { __defaultPushWiki } from "../../src/knowledge/ingest";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
const savedTemplate = process.env.GIT_TEMPLATE_DIR;
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (savedTemplate === undefined) delete process.env.GIT_TEMPLATE_DIR;
  else process.env.GIT_TEMPLATE_DIR = savedTemplate;
});
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe", encoding: "utf8" });

/** An executable that records it ran by creating `marker`. */
function planted(path: string, marker: string): void {
  writeFileSync(path, `#!/bin/sh\ntouch "${marker}"\n`);
  chmodSync(path, 0o755);
}

/** A hooks directory whose every client-side hook records it ran. */
function hooksDir(marker: string): string {
  const d = tmp("slaude-hooks-");
  const hooks = join(d, "hooks");
  mkdirSync(hooks);
  for (const h of ["pre-commit", "post-commit", "commit-msg", "pre-push", "post-checkout", "reference-transaction"]) planted(join(hooks, h), marker);
  return d;
}

function bareRemote(): string {
  const bare = tmp("slaude-bare-");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare], { stdio: "pipe" });
  return bare;
}

describe("brain-sync's checkpoint commit in a node-writable KB repo", () => {
  test("a planted hook and fsmonitor do not run; the commit is made", () => {
    const repo = tmp("slaude-kbrepo-");
    const marker = join(tmp("slaude-marker-"), "ran");
    git(repo, "init", "-q");
    for (const h of ["pre-commit", "post-commit", "commit-msg", "reference-transaction"]) planted(join(repo, ".git", "hooks", h), marker);
    const fsmon = join(repo, ".git", "fsmon.sh");
    planted(fsmon, marker);
    git(repo, "config", "core.fsmonitor", fsmon);
    writeFileSync(join(repo, "page.md"), "# page\n");
    ensureGitRepo(repo);
    expect(existsSync(marker)).toBe(false);
    expect(git(repo, "log", "--format=%s").trim()).toBe("slaude brain sync checkpoint");
  });
});

describe("pushes clone a template's hooks but never run them", () => {
  test("pushToRepo", () => {
    const marker = join(tmp("slaude-marker-"), "ran");
    process.env.GIT_TEMPLATE_DIR = hooksDir(marker);
    const remote = bareRemote();
    const skill = tmp("slaude-skill-");
    writeFileSync(join(skill, "SKILL.md"), "---\nname: s\n---\nbody\n");
    pushToRepo(remote, [{ slug: "s", dir: skill }]);
    expect(existsSync(marker)).toBe(false);
    expect(git(remote, "log", "--format=%s", "main").trim()).toContain("slaude: sync");
  });

  test("pushKbRaw", () => {
    const marker = join(tmp("slaude-marker-"), "ran");
    process.env.GIT_TEMPLATE_DIR = hooksDir(marker);
    const remote = bareRemote();
    const kb = tmp("slaude-kb-");
    mkdirSync(join(kb, "raw"));
    writeFileSync(join(kb, "raw", "a.md"), "a\n");
    pushKbRaw(remote, "main", kb);
    expect(existsSync(marker)).toBe(false);
    expect(git(remote, "log", "--format=%s", "main").trim()).toBe("slaude: sync raw");
  });

  test("ingest's wiki push", async () => {
    const marker = join(tmp("slaude-marker-"), "ran");
    process.env.GIT_TEMPLATE_DIR = hooksDir(marker);
    const remote = bareRemote();
    const kb = tmp("slaude-kb-");
    mkdirSync(join(kb, "wiki"));
    writeFileSync(join(kb, "wiki", "p.md"), "p\n");
    await __defaultPushWiki({ repoUrl: remote, ref: "main", kbDir: kb });
    expect(existsSync(marker)).toBe(false);
    expect(git(remote, "log", "--format=%s", "main").trim()).toBe("slaude: ingest");
  });
});

describe("git environments", () => {
  const src = { PATH: "/bin", HOME: "/h", SLAUDE_MASTER_KEY: "x", SLACK_BOT_TOKEN: "x", ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "x", SSH_AUTH_SOCK: "/s" };
  test("gitEnv drops gateway secrets and provider credentials, keeps what a remote needs", () => {
    const e = gitEnv(src);
    for (const k of ["SLAUDE_MASTER_KEY", "SLACK_BOT_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) expect(e[k]).toBeUndefined();
    expect(e).toMatchObject({ PATH: "/bin", HOME: "/h", SSH_AUTH_SOCK: "/s", GIT_TERMINAL_PROMPT: "0" });
  });
  test("localGitEnv is minimal", () => {
    expect(localGitEnv(src)).toEqual({ PATH: "/bin", HOME: "/h", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
  });
});
