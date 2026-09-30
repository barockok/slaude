import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { bashTool, bashOutputTool, bashKillTool, cleanupCommand } from "../../src/remote/tools/bash";
import { shq } from "../../src/remote/shell";
import type { Exec } from "../../src/remote/types";
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

  // A command that returns but leaves a child running: `.exit` exists, the group lives on.
  const startOrphan = async () => {
    const start = await bashTool(ctx, { command: `sleep 60 & echo $! > ${root}/child.pid`, run_in_background: true });
    const id = text(start).match(/ID: ([0-9a-f]+)/)![1]!;
    for (let n = 0; n < 50; n++) {
      const r = await localExec(`[ -e "$HOME"/.slaude-bg/${ctx.sessionKey}/${id}.exit ] && [ -s ${root}/child.pid ] && echo yes`, { timeoutMs: 5000 });
      if (r.stdout.trim() === "yes") break;
      await Bun.sleep(100);
    }
    const child = (await localExec(`cat ${root}/child.pid`, { timeoutMs: 5000 })).stdout.trim();
    const alive = async () => (await localExec(`kill -0 ${child} 2>/dev/null && echo alive || echo dead`, { timeoutMs: 5000 })).stdout.trim();
    return { id, child, alive };
  };
  const reap = (child: string) => localExec(`kill ${child} 2>/dev/null; true`, { timeoutMs: 5000 });

  it("bash_kill kills orphaned children of a job whose command already returned", async () => {
    const { id, child, alive } = await startOrphan();
    try {
      expect(await alive()).toBe("alive");
      const out = text(await bashOutputTool(ctx, { bash_id: id }));
      expect(out).toContain("exit code 0");
      expect(out).toContain("still running");
      expect(text(await bashKillTool(ctx, { shell_id: id }))).toContain("Killed");
      await Bun.sleep(200);
      expect(await alive()).toBe("dead");
    } finally { await reap(child); }
  }, 20_000);

  it("session cleanup kills orphaned children of a finished job", async () => {
    const { child, alive } = await startOrphan();
    try {
      expect(await alive()).toBe("alive");
      await localExec(cleanupCommand(ctx.sessionKey), { timeoutMs: 20_000 });
      await Bun.sleep(200);
      expect(await alive()).toBe("dead");
    } finally { await reap(child); }
  }, 20_000);

  it("a pid reused by an unrelated process is never signalled, and the job is forgotten", async () => {
    // Own group leader without our marker, spawned by this test only.
    const sp = await localExec(
      `perl -e 'setpgrp(0,0); exec @ARGV' sleep 30 > /dev/null 2>&1 < /dev/null & echo $!`,
      { timeoutMs: 5000 },
    );
    const stranger = sp.stdout.trim();
    const dir = `"$HOME"/.slaude-bg/${ctx.sessionKey}`;
    const alive = async () => (await localExec(`kill -0 ${stranger} 2>/dev/null && echo alive || echo dead`, { timeoutMs: 5000 })).stdout.trim();
    try {
      expect(stranger).toMatch(/^\d+$/);
      await localExec(`mkdir -p ${dir}; : > ${dir}/deadbeef.log; echo ${stranger} > ${dir}/deadbeef.pid; : > ${dir}/deadbee0.log; echo ${stranger} > ${dir}/deadbee0.pid`, { timeoutMs: 5000 });
      expect(text(await bashOutputTool(ctx, { bash_id: "deadbee0" }))).toContain("unknown");
      const k = await bashKillTool(ctx, { shell_id: "deadbeef" });
      expect(text(k)).toContain("no longer belongs");
      expect(text(k)).not.toContain("Killed");
      const pidGone = await localExec(`[ -e ${dir}/deadbeef.pid ] && echo present || echo gone`, { timeoutMs: 5000 });
      expect(pidGone.stdout.trim()).toBe("gone");
      expect(await alive()).toBe("alive");
      await localExec(`echo ${stranger} > ${dir}/deadbee1.pid`, { timeoutMs: 5000 });
      await localExec(cleanupCommand(ctx.sessionKey), { timeoutMs: 20_000 });
      expect(await alive()).toBe("alive");
    } finally { await reap(stranger); }
  }, 30_000);
});

// Kill safety: `kill` is shadowed by a function that only prints, and `ps` by one that
// shows no process, so no test here can ever signal a real process group. `alive`
// decides what `kill -0` answers ("dies" = alive until a TERM is sent).
describe("kill safety (simulated signals)", () => {
  const key = `ks${process.pid}${Date.now()}`;
  const dir = `"$HOME"/.slaude-bg/${key}`;
  type Alive = "alive" | "dead" | "dies";
  const zero = { alive: "return 0", dead: "return 1", dies: '[ -z "$T" ]; return $?' };
  // Probes (`kill -0`) go to a file so they never mix into the tool's stdout parsing.
  const probeFile = join(homedir(), ".slaude-bg", `${key}.probes`);
  const sim = (log: string[], alive: Alive | boolean): Exec => (cmd, o) => {
    const mode = alive === true ? "alive" : alive === false ? "dead" : alive;
    rmSync(probeFile, { force: true });
    return localExec(
      `ps() { return 0; }; kill() { case "$1" in -0) echo "SIG $*" >> '${probeFile}'; ${zero[mode]};; -TERM) T=1;; esac; echo "SIG $*"; }\n${cmd}`,
      o,
    ).then((r) => {
      log.push(r.stdout + (existsSync(probeFile) ? readFileSync(probeFile, "utf8") : ""));
      return r;
    });
  };
  const seed = (id: string, pid: string | null, exit?: string) =>
    localExec(
      `mkdir -p ${dir}; : > ${dir}/${id}.log; ` +
        (pid === null ? "" : `printf '%s' ${shq(pid)} > ${dir}/${id}.pid; `) +
        (exit === undefined ? "" : `printf '%s' ${shq(exit)} > ${dir}/${id}.exit`),
      { timeoutMs: 5000 },
    );
  const sigs = (log: string[]) => log.join("").split("\n").filter((l) => l.startsWith("SIG "));
  const sent = (log: string[]) => sigs(log).filter((l) => !l.startsWith("SIG -0 "));
  const mk = (log: string[], alive: Alive | boolean = "dies") => ({ exec: sim(log, alive), root: "/", sessionKey: key, cwd: { value: "/" }, bg: new Map() }) as any;
  const HOSTILE = ["1", "0", "abc", "", "-1", "12 34", "01", "12\n34"];
  afterEach(async () => {
    await localExec(`rm -rf ${dir}`, { timeoutMs: 5000 });
    rmSync(probeFile, { force: true });
  });

  it("bash_kill signals a valid pid only", async () => {
    const log: string[] = [];
    await seed("aaaaaaaa", "4242");
    expect((await bashKillTool(mk(log), { shell_id: "aaaaaaaa" })).isError).toBeFalsy();
    expect(sent(log)).toEqual(["SIG -TERM -4242"]);
  });
  it("bash_kill never signals an invalid pid file", async () => {
    for (const [n, bad] of HOSTILE.entries()) {
      const log: string[] = [];
      const id = `b000000${n}`;
      await seed(id, bad);
      await bashKillTool(mk(log), { shell_id: id });
      expect(sigs(log)).toEqual([]);
    }
  });
  it("bash_kill still signals a finished job whose group has orphaned children alive", async () => {
    const log: string[] = [];
    await seed("cccccccc", "4242", "0");
    await bashKillTool(mk(log), { shell_id: "cccccccc" });
    expect(sent(log)).toEqual(["SIG -TERM -4242"]);
  });
  it("bash_kill on a group that is already gone signals nothing and says killed", async () => {
    const log: string[] = [];
    await seed("c0000000", "4242");
    expect(text(await bashKillTool(mk(log, "dead"), { shell_id: "c0000000" }))).toContain("Killed");
    expect(sent(log)).toEqual([]);
  });
  it("bash_kill removes the pid file; bash_output then says killed without probing", async () => {
    const log: string[] = [];
    await seed("dddddddd", "4242");
    await bashKillTool(mk(log), { shell_id: "dddddddd" });
    const gone = await localExec(`[ -e ${dir}/dddddddd.pid ] && echo present || echo gone`, { timeoutMs: 5000 });
    expect(gone.stdout.trim()).toBe("gone");
    const before = sigs(log).length;
    expect(text(await bashOutputTool(mk(log, true), { bash_id: "dddddddd" }))).toContain("killed");
    expect(sigs(log).length).toBe(before);
  });
  it("bash_output reports running only for a valid, live pid; junk is unknown, finished is from .exit", async () => {
    const log: string[] = [];
    await seed("eeeeeeee", "4242");
    expect(text(await bashOutputTool(mk(log, true), { bash_id: "eeeeeeee" }))).toContain("running");
    for (const [n, bad] of HOSTILE.entries()) {
      const id = `f000000${n}`;
      await seed(id, bad);
      const t = text(await bashOutputTool(mk(log, true), { bash_id: id }));
      expect(t).toContain("unknown");
      expect(t).not.toContain("running");
    }
    log.length = 0;
    await seed("99999999", "4242", "3");
    const live = text(await bashOutputTool(mk(log, true), { bash_id: "99999999" }));
    expect(live).toContain("exit code 3");
    expect(live).toContain("still running");
    const gone = text(await bashOutputTool(mk(log, false), { bash_id: "99999999" }));
    expect(gone).toContain("exit code 3");
    expect(gone).not.toContain("still running");
    expect(sent(log)).toEqual([]);
  });
  it("cleanup signals every valid pid whose group is alive, finished job or not, never invalid ones", async () => {
    const log: string[] = [];
    await seed("11111111", "4242");
    await seed("22222222", "4343", "0");
    for (const [n, bad] of HOSTILE.entries()) await seed(`3000000${n}`, bad);
    await sim(log, true)(cleanupCommand(key), { timeoutMs: 20_000 });
    expect(sent(log)).toEqual(["SIG -TERM -4242", "SIG -TERM -4343", "SIG -KILL -4242", "SIG -KILL -4343"]);
    // Nothing but the two valid pids was even probed.
    expect(sigs(log).every((l) => l.endsWith("-4242") || l.endsWith("-4343"))).toBe(true);
  });
  it("an empty session key throws before any command is built or run", async () => {
    expect(() => cleanupCommand("!!!")).toThrow();
    let ran = 0;
    const c = { exec: (async () => { ran++; return {} as any; }) as Exec, root: "/", sessionKey: "", cwd: { value: "/" }, bg: new Map() };
    await expect(bashOutputTool(c, { bash_id: "aaaaaaaa" })).rejects.toThrow();
    await expect(bashKillTool(c, { shell_id: "aaaaaaaa" })).rejects.toThrow();
    await expect(bashTool(c, { command: "true", run_in_background: true })).rejects.toThrow();
    expect(ran).toBe(0);
  });
});
