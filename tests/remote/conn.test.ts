import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { connect } from "node:net";
import { spawnSync } from "node:child_process";
import { utils } from "ssh2";
import { RemoteConn } from "../../src/remote/conn";
import { RemoteError } from "../../src/remote/types";
import { startTestSshServer } from "./ssh-test-server";

const pair = utils.generateKeyPairSync("ed25519");
const stranger = utils.generateKeyPairSync("ed25519");
let srv: Awaited<ReturnType<typeof startTestSshServer>>;

const mk = (privateKey = pair.private, port = () => srv.port) =>
  new RemoteConn({ socket: () => connect(port(), "127.0.0.1"), privateKey, reconnectDelayMs: 10, readyTimeoutMs: 3000 });

beforeAll(async () => { srv = await startTestSshServer({ authorizedPublicKey: pair.public }); });
afterAll(async () => { await srv.stop(); });

describe("RemoteConn", () => {
  it("runs a command and returns stdout, stderr (marker stripped) and exit code", async () => {
    const c = mk();
    const r = await c.exec("echo out; echo err >&2; exit 3", { timeoutMs: 5000 });
    expect(r.stdout).toBe("out\n");
    expect(r.stderr).toBe("err\n");
    expect(r.code).toBe(3);
    expect(r.timedOut).toBe(false);
    c.close();
  });

  it("feeds stdin", async () => {
    const c = mk();
    const r = await c.exec("cat", { stdin: "hello\nworld", timeoutMs: 5000 });
    expect(r.stdout).toBe("hello\nworld");
    c.close();
  });

  it("runs parallel execs over one connection", async () => {
    const c = mk();
    const t = performance.now();
    await Promise.all(Array.from({ length: 5 }, () => c.exec("sleep 0.3", { timeoutMs: 5000 })));
    expect(performance.now() - t).toBeLessThan(1200);
    c.close();
  });

  it("truncates huge output keeping head and tail", async () => {
    const c = mk();
    const r = await c.exec("i=0; while [ $i -lt 20000 ]; do echo line$i; i=$((i+1)); done", { timeoutMs: 10000, maxOutput: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.stdout.startsWith("line0\n")).toBe(true);
    expect(r.stdout).toContain("line19999");
    expect(r.stdout).toContain("[truncated");
    expect(r.stdout.length).toBeLessThan(6000);
    c.close();
  });

  it("on timeout kills the whole process group (no orphan) and marks timedOut", async () => {
    const c = mk();
    const tag = `slaude-orphan-${process.pid}-${Date.now()}`;
    const r = await c.exec(`sh -c 'sleep 30; echo ${tag}' & sleep 30`, { timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
    await Bun.sleep(1500);
    const left = spawnSync("/bin/sh", ["-c", `ps -A -o command= | grep -v grep | grep -c 'sleep 30; echo ${tag}' || true`], { encoding: "utf8" });
    expect(left.stdout.trim()).toBe("0");
    c.close();
  });

  it("classifies a rejected key as REMOTE_AUTH_FAILED", async () => {
    const c = mk(stranger.private);
    await expect(c.exec("true", { timeoutMs: 5000 })).rejects.toMatchObject({ code: "REMOTE_AUTH_FAILED" });
    c.close();
  });

  it("classifies a dead endpoint as REMOTE_UNREACHABLE after one retry", async () => {
    const c = mk(pair.private, () => 1); // nothing listens on port 1
    const err = await c.exec("true", { timeoutMs: 5000 }).catch((e) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect(err.code).toBe("REMOTE_UNREACHABLE");
    c.close();
  });

  it("a drop DURING a command is REMOTE_UNREACHABLE and the command is not re-run", async () => {
    let port = srv.port;
    const c = mk(pair.private, () => port);
    const marker = `/tmp/slaude-conn-${process.pid}-${Date.now()}`;
    const running = c.exec(`echo ran >> ${marker}; sleep 5`, { timeoutMs: 10_000 });
    await Bun.sleep(500);
    await srv.stop();
    const err = await running.catch((e) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect(err.code).toBe("REMOTE_UNREACHABLE");
    expect(err.started).toBe(true);
    srv = await startTestSshServer({ authorizedPublicKey: pair.public });
    port = srv.port;
    await Bun.sleep(5000);
    expect((await Bun.file(marker).text()).trim().split("\n")).toEqual(["ran"]);
    c.close();
  }, 20_000);

  it("reconnects after the server restarts (laptop slept and woke)", async () => {
    let port = srv.port;
    const c = mk(pair.private, () => port);
    expect((await c.exec("echo 1", { timeoutMs: 5000 })).stdout).toBe("1\n");
    await srv.stop();
    await expect(c.exec("echo 2", { timeoutMs: 3000 })).rejects.toMatchObject({ code: "REMOTE_UNREACHABLE" });
    srv = await startTestSshServer({ authorizedPublicKey: pair.public });
    port = srv.port;
    expect((await c.exec("echo 3", { timeoutMs: 5000 })).stdout).toBe("3\n");
    c.close();
  });
});
