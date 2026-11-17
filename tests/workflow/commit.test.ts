import { describe, it, expect } from "bun:test";
import { commitScript, createCommitter, parseCommitOutput, shq } from "../../src/workflow/commit";
import type { WorkflowThreadRow } from "../../src/db/workflow";
import type { CommitRequest } from "../../src/workflow/types";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const row = { run_id: "run-1", session_id: "S1", channel_id: "C1", thread_ts: "1.0" } as WorkflowThreadRow;
const req = (over: Partial<CommitRequest> = {}): CommitRequest => ({ requestId: "run-1:commit:1", path: "docs/factory/run-1/prd.md", content: "# PRD\nline", message: "add prd", ...over });

describe("shq", () => {
  it("quotes any value so the shell sees it literally", () => {
    for (const v of ["plain", "it's", "$(touch /tmp/x)", "a b", "`x`", "x\ny", ""]) {
      expect(execFileSync("sh", ["-c", `printf %s ${shq(v)}`]).toString()).toBe(v);
    }
  });
});

describe("parseCommitOutput", () => {
  it("reads the last result line", () => {
    expect(parseCommitOutput({ ok: true, text: "noise\nSHA:abcdef1\n" })).toEqual({ sha: "abcdef1" });
    expect(parseCommitOutput({ ok: true, text: "SKIP:no factory branch" })).toEqual({ skipped: "no factory branch" });
  });
  it("throws on an error line, no result, or a malformed sha", () => {
    expect(() => parseCommitOutput({ ok: true, text: "ERR:more than one repository" })).toThrow("more than one repository");
    expect(() => parseCommitOutput({ ok: false, text: "boom" })).toThrow("no result");
    expect(() => parseCommitOutput({ ok: true, text: "SHA:xyz" })).toThrow("malformed");
  });
});

describe("createCommitter", () => {
  it("is skipped without a sandbox and never calls the sandbox", async () => {
    let called = 0;
    const commit = createCommitter({ inSandbox: async () => false, bash: async () => { called++; return { ok: true, text: "" }; } });
    expect(await commit(row, req())).toEqual({ skipped: "no sandbox" });
    expect(called).toBe(0);
  });

  it("sends one script to the thread's sandbox session and returns its result", async () => {
    const seen: Array<[string, string]> = [];
    const commit = createCommitter({ inSandbox: async () => true, root: () => "/workspace", bash: async (sid, cmd) => { seen.push([sid, cmd]); return { ok: true, text: "SHA:abc1234" }; } });
    expect(await commit(row, req())).toEqual({ sha: "abc1234" });
    expect(seen[0]![0]).toBe("S1");
    expect(seen[0]![1]).toContain("Factory-Request: run-1:commit:1");
  });

  it("serializes calls for one run", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const commit = createCommitter({
      inSandbox: async () => true,
      bash: async (_s, cmd) => {
        const id = cmd.includes("run-1:commit:1") ? "first" : "second";
        order.push(`start ${id}`);
        if (id === "first") await gate;
        order.push(`end ${id}`);
        return { ok: true, text: "SHA:abc1234" };
      },
    });
    const a = commit(row, req());
    const b = commit(row, req({ requestId: "run-1:commit:2" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["start first"]);
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(["start first", "end first", "start second", "end second"]);
  });

  it("refuses content over the cap", async () => {
    const commit = createCommitter({ inSandbox: async () => true, bash: async () => ({ ok: true, text: "SHA:abc1234" }) });
    await expect(commit(row, req({ content: "x".repeat(64 * 1024 + 1) }))).rejects.toThrow("too large");
  });
});

/** Run the real script with sh against a scratch repository, as the sandbox would. */
function run(root: string, c: CommitRequest): string {
  try {
    return execFileSync("sh", ["-c", commitScript(root, c)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    // The script exits non-zero after printing its ERR line; return what it printed.
    return String((e as { stdout?: string }).stdout ?? "");
  }
}
function repo(root: string, name: string, branch: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  g("init", "-q", "-b", branch);
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "x");
  g("add", ".");
  g("commit", "-q", "-m", "init");
  return dir;
}
const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();

describe("commitScript against a real repository", () => {
  it("commits once, repeats return the same sha, and unchanged content returns HEAD", () => {
    const root = mkdtempSync(join(tmpdir(), "commit-"));
    const dir = repo(root, "svc", "factory/pl-1");
    const first = run(root, req()).trim();
    expect(first).toMatch(/^SHA:[0-9a-f]{40}$/);
    expect(readFileSync(join(dir, "docs/factory/run-1/prd.md"), "utf8")).toBe("# PRD\nline");
    expect(git(dir, "log", "-1", "--format=%B")).toContain("Factory-Request: run-1:commit:1");
    const count = git(dir, "rev-list", "--count", "HEAD");
    expect(run(root, req()).trim()).toBe(first);
    expect(git(dir, "rev-list", "--count", "HEAD")).toBe(count);
    // same content under a new request id: nothing to commit, HEAD comes back
    expect(run(root, req({ requestId: "run-1:commit:2" })).trim()).toBe(first);
    expect(git(dir, "rev-list", "--count", "HEAD")).toBe(count);
  });

  it("a request id that is a prefix of another does not match it", () => {
    const root = mkdtempSync(join(tmpdir(), "commit-"));
    const dir = repo(root, "svc", "factory/pl-1");
    run(root, req({ requestId: "run-1:commit:10", path: "a.md", content: "a" }));
    const before = git(dir, "rev-list", "--count", "HEAD");
    run(root, req({ requestId: "run-1:commit:1", path: "b.md", content: "b" }));
    expect(git(dir, "rev-list", "--count", "HEAD")).toBe(String(Number(before) + 1));
  });

  it("commits only the target path and leaves other staged work alone", () => {
    const root = mkdtempSync(join(tmpdir(), "commit-"));
    const dir = repo(root, "svc", "factory/pl-1");
    writeFileSync(join(dir, "wip.txt"), "wip");
    git(dir, "add", "wip.txt");
    run(root, req());
    expect(git(dir, "status", "--porcelain")).toBe("A  wip.txt");
  });

  it("is skipped with no factory branch and fails with two", () => {
    const root = mkdtempSync(join(tmpdir(), "commit-"));
    repo(root, "svc", "main");
    expect(run(root, req()).trim()).toBe("SKIP:no factory branch");
    repo(root, "a", "factory/x");
    repo(root, "b", "factory/y");
    expect(run(root, req()).trim()).toContain("ERR:more than one repository");
  });

  it("values with quotes or shell syntax cannot break out of the script", () => {
    const root = mkdtempSync(join(tmpdir(), "commit-"));
    const dir = repo(root, "svc", "factory/pl-1");
    const marker = join(root, "pwned");
    const out = run(root, req({ path: `docs/it's $(touch ${marker}).md`, message: `msg '; touch ${marker}; echo '`, content: `$(touch ${marker})\n'q'` }));
    expect(out.trim()).toMatch(/^SHA:/);
    expect(() => readFileSync(marker)).toThrow();
    expect(readFileSync(join(dir, `docs/it's $(touch ${marker}).md`), "utf8")).toBe(`$(touch ${marker})\n'q'`);
  });
});
