import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashTool, bashOutputTool, bashKillTool, cleanupCommand } from "../../src/remote/tools/bash";
import { localExec } from "./local-exec";

let root: string;
let ctx: any;
const text = (r: any) => r.content.map((c: any) => c.text).join("");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "slaude-remote-bash-"));
  mkdirSync(join(root, "sub"));
  ctx = { exec: localExec, root, sessionKey: `test${process.pid}${Date.now()}`, cwd: { value: root }, bg: new Map() };
});
afterEach(async () => { await localExec(cleanupCommand(ctx.sessionKey), { timeoutMs: 20_000 }); });

describe("bash", () => {
  it("runs in the root dir and returns output", async () => {
    const r = await bashTool(ctx, { command: "pwd -P; echo hi" });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("hi");
  });
  it("keeps the working directory between calls, like the built-in", async () => {
    await bashTool(ctx, { command: "cd sub" });
    expect(text(await bashTool(ctx, { command: "basename \"$(pwd)\"" })).trim()).toBe("sub");
  });
  it("marks non-zero exit as an error with the code", async () => {
    const r = await bashTool(ctx, { command: "echo nope >&2; exit 4" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Exit code 4");
    expect(text(r)).toContain("nope");
  });
  it("times out and says so", async () => {
    const r = await bashTool(ctx, { command: "sleep 5", timeout: 300 });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("timed out");
  });
});

describe("background jobs", () => {
  it("the pid file holds the job's own process group, even for a session's first job", async () => {
    const start = await bashTool(ctx, { command: "sleep 30", run_in_background: true });
    const id = text(start).match(/ID: ([0-9a-f]+)/)![1]!;
    const r = await localExec(
      `P=$(cat "$HOME"/.slaude-bg/${ctx.sessionKey}/${id}.pid); [ "$(ps -o pgid= -p "$P" | tr -d ' ')" = "$P" ] && echo own-group`,
      { timeoutMs: 5000 },
    );
    expect(r.stdout.trim()).toBe("own-group");
    expect(text(await bashOutputTool(ctx, { bash_id: id }))).toContain("running");
  });

  it("start → output (incremental) → exit status", async () => {
    const start = await bashTool(ctx, { command: "echo one; sleep 1; echo two", run_in_background: true });
    const id = text(start).match(/ID: ([0-9a-f]+)/)![1]!;
    await Bun.sleep(300);
    const first = text(await bashOutputTool(ctx, { bash_id: id }));
    expect(first).toContain("one");
    expect(first).toContain("running");
    await Bun.sleep(1500);
    const second = text(await bashOutputTool(ctx, { bash_id: id }));
    expect(second).toContain("two");
    expect(second).not.toContain("one");
    expect(second).toContain("exit code 0");
  });
  it("kill stops the job's whole group", async () => {
    const start = await bashTool(ctx, { command: "sleep 60 & sleep 60", run_in_background: true });
    const id = text(start).match(/ID: ([0-9a-f]+)/)![1]!;
    await Bun.sleep(300);
    expect((await bashKillTool(ctx, { shell_id: id })).isError).toBeFalsy();
    expect(text(await bashOutputTool(ctx, { bash_id: id }))).toMatch(/killed|exit/);
  });
  it("rejects ids that are not ours", async () => {
    expect((await bashOutputTool(ctx, { bash_id: "../../etc" })).isError).toBe(true);
  });
});
