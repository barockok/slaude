import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { connect } from "node:net";
import { Duplex } from "node:stream";
import { Client } from "ssh2";
import { RemoteConn, type SocketFactory } from "../../src/remote/conn";
import { tailcatSocket } from "../../src/remote/tailcat";
import { RemoteError } from "../../src/remote/types";
import { startTestSshServer, testKeyPair } from "./ssh-test-server";

const pair = testKeyPair();
let srv: Awaited<ReturnType<typeof startTestSshServer>>;

const mk = (socket: SocketFactory = () => connect(srv.port, "127.0.0.1")) =>
  new RemoteConn({ socket, privateKey: pair.private, reconnectDelayMs: 10, readyTimeoutMs: 3000 });

beforeAll(async () => { srv = await startTestSshServer({ authorizedPublicKey: pair.public }); });
afterAll(async () => { await srv.stop(); });

const realExec = Client.prototype.exec;
const patchExec = (fn: (this: Client, cmd: string, rest: any[]) => boolean | undefined) => {
  (Client.prototype as any).exec = function (this: Client, cmd: string, ...rest: any[]) {
    const r = fn.call(this, cmd, rest);
    return r === undefined ? (realExec as any).call(this, cmd, ...rest) : r;
  };
};
const unpatchExec = () => { Client.prototype.exec = realExec; };

describe("RemoteConn fault handling", () => {
  it("a channel-open failure on one exec does not fail a concurrent exec", async () => {
    patchExec((cmd, rest) => {
      if (!cmd.includes("FAILME")) return undefined;
      const cb = rest[rest.length - 1];
      queueMicrotask(() => cb(new Error("Channel open failure")));
      return true;
    });
    const c = mk();
    try {
      const slow = c.exec("sleep 1; echo ok", { timeoutMs: 5000 });
      await Bun.sleep(300); // the slow command is running on the shared connection
      const bad = c.exec("FAILME", { timeoutMs: 5000 }).catch((e) => e);
      expect(await bad).toBeInstanceOf(RemoteError);
      expect((await slow).stdout).toBe("ok\n");
    } finally {
      unpatchExec();
      c.close();
    }
  });

  it("close() during an in-flight connect does not resurrect the connection", async () => {
    const socks: Duplex[] = [];
    const c = mk(async () => {
      await Bun.sleep(200);
      const s = connect(srv.port, "127.0.0.1");
      socks.push(s);
      return s;
    });
    const running = c.exec("echo hi", { timeoutMs: 5000 }).catch((e) => e);
    await Bun.sleep(50);
    c.close();
    const err = await running;
    expect(err).toBeInstanceOf(RemoteError);
    expect(err.code).toBe("REMOTE_UNREACHABLE");
    await Bun.sleep(300);
    expect(socks.length).toBe(1);
    expect(socks[0]!.destroyed).toBe(true);
  });

  it("a synchronous 'Not connected' throw from exec maps to REMOTE_UNREACHABLE", async () => {
    patchExec(() => { throw new Error("Not connected"); });
    const c = mk();
    try {
      const err = await c.exec("true", { timeoutMs: 5000 }).catch((e) => e);
      expect(err).toBeInstanceOf(RemoteError);
      expect(err.code).toBe("REMOTE_UNREACHABLE");
    } finally {
      unpatchExec();
      c.close();
    }
  });

  it("a throwing kill exec on timeout does not crash the process", async () => {
    patchExec((cmd) => { if (cmd.startsWith("kill ")) throw new Error("Not connected"); return undefined; });
    const c = mk();
    try {
      const r = await c.exec("sleep 2", { timeoutMs: 300 });
      expect(r.timedOut).toBe(true);
    } finally {
      unpatchExec();
      c.close();
    }
  });

  it("a link that goes silent after the timeout is REMOTE_UNREACHABLE started=true within the grace, not a 'killed' result", async () => {
    let frozen = false;
    let real: ReturnType<typeof connect> | undefined;
    const c = mk(() => {
      const r = (real = connect(srv.port, "127.0.0.1"));
      const proxy = new Duplex({
        read() {},
        write(chunk, _enc, cb) { if (!frozen) r.write(chunk); cb(); },
        final(cb) { r.end(); cb(); },
        destroy(err, cb) { r.destroy(); cb(err); },
      });
      r.on("data", (d) => { if (!frozen) proxy.push(d); });
      r.on("close", () => proxy.push(null));
      return proxy;
    });
    try {
      const t = performance.now();
      const running = c.exec("sleep 3", { timeoutMs: 400 }).catch((e) => e);
      await Bun.sleep(200);
      frozen = true; // laptop slept: nothing crosses the link from now on
      const err = await running;
      const took = performance.now() - t;
      expect(err).toBeInstanceOf(RemoteError);
      expect(err.code).toBe("REMOTE_UNREACHABLE");
      expect(err.started).toBe(true);
      expect(took).toBeLessThan(8000);
    } finally {
      c.close();
      real?.destroy();
    }
  }, 20_000);

  it("caps stderr like stdout, with the pgid marker stripped", async () => {
    const c = mk();
    const r = await c.exec("i=0; while [ $i -lt 20000 ]; do echo err$i >&2; i=$((i+1)); done", { timeoutMs: 10000, maxOutput: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.stderr.startsWith("err0\n")).toBe(true);
    expect(r.stderr).toContain("err19999");
    expect(r.stderr).toContain("[truncated");
    expect(r.stderr.length).toBeLessThan(6000);
    c.close();
  });

  it("a missing tailcat binary fails the connection with REMOTE_UNREACHABLE and no unhandled error", async () => {
    const c = new RemoteConn({
      socket: tailcatSocket("some-node.example", "/nonexistent-binary"),
      privateKey: pair.private,
      reconnectDelayMs: 10,
      readyTimeoutMs: 3000,
    });
    const err = await c.exec("true", { timeoutMs: 5000 }).catch((e) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect(err.code).toBe("REMOTE_UNREACHABLE");
    c.close();
    await Bun.sleep(100);
  });
});
