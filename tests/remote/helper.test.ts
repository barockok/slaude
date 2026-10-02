import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { HelperClient } from "../../src/remote/helper-client";
import { startTestSshServer, testKeyPair } from "./ssh-test-server";

const pair = testKeyPair();
let srv: Awaited<ReturnType<typeof startTestSshServer>>;
beforeAll(async () => { srv = await startTestSshServer({ authorizedPublicKey: pair.public }); });
afterAll(async () => { await srv.stop(); });

const mk = () => new HelperClient({ transport: { kind: "tcp", host: "127.0.0.1", port: srv.port }, privateKey: pair.private });

describe("HelperClient", () => {
  it("execs through the helper subprocess", async () => {
    const h = mk();
    const r = await h.exec("echo via-helper", { timeoutMs: 5000 });
    expect(r.stdout).toBe("via-helper\n");
    await h.dispose();
  });

  it("surfaces transport errors with their code", async () => {
    const bad = testKeyPair();
    const h = new HelperClient({ transport: { kind: "tcp", host: "127.0.0.1", port: srv.port }, privateKey: bad.private });
    await expect(h.exec("true", { timeoutMs: 5000 })).rejects.toMatchObject({ code: "REMOTE_AUTH_FAILED" });
    await h.dispose();
  });

  it("restarts a crashed helper on the next call", async () => {
    const h = mk();
    await h.exec("true", { timeoutMs: 5000 });
    h.__killHelperForTests();
    await Bun.sleep(100);
    const r = await h.exec("echo again", { timeoutMs: 5000 });
    expect(r.stdout).toBe("again\n");
    await h.dispose();
  });

  it("never passes the key through argv or env", async () => {
    const h = mk();
    await h.exec("true", { timeoutMs: 5000 });
    const { argv, env } = h.__spawnInfoForTests();
    expect(argv.join(" ")).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(env)).not.toContain("PRIVATE KEY");
    await h.dispose();
  });

  it("keeps the started flag across the helper hop when the link drops mid-command", async () => {
    const own = await startTestSshServer({ authorizedPublicKey: pair.public });
    const h = new HelperClient({ transport: { kind: "tcp", host: "127.0.0.1", port: own.port }, privateKey: pair.private });
    await h.exec("true", { timeoutMs: 5000 });
    const p = h.exec("sleep 30", { timeoutMs: 20_000 });
    const seen = p.then(() => null, (e) => e);
    await Bun.sleep(300);
    await own.stop();
    const err = await seen;
    expect(err).toMatchObject({ code: "REMOTE_UNREACHABLE", started: true });
    await h.dispose();
  });

  it("a late exit of a released helper does not fail the new helper's in-flight exec", async () => {
    const h = mk();
    await h.exec("true", { timeoutMs: 5000 });
    const old = h.__childForTests()!;
    // Hold back the old child's exit event so it lands after the new helper is ready and busy.
    const held: { deliver?: () => void } = {};
    const emit = old.emit.bind(old);
    (old as any).emit = (ev: string, ...args: unknown[]) => {
      if (ev !== "exit") return emit(ev, ...args);
      held.deliver = () => { emit(ev, ...args); };
      return true;
    };
    await h.release();
    const next = h.exec("sleep 2; echo fresh", { timeoutMs: 10_000 });
    while (h.__pendingCountForTests() < 1) await new Promise((r) => setImmediate(r));
    while (!held.deliver) await new Promise((r) => setImmediate(r));
    held.deliver();
    expect((await next).stdout).toBe("fresh\n");
    await h.dispose();
  });

  it("exec racing release after the helper is ready rejects with a typed error and leaks nothing", async () => {
    const h = mk();
    await h.exec("true", { timeoutMs: 5000 });
    const seen = h.exec("true", { timeoutMs: 5000 }).then(() => null, (e) => e);
    await h.release(); // same tick: the child is gone between `await ready` and the write
    const err = await seen;
    expect(err).toMatchObject({ name: "RemoteError", code: "REMOTE_UNREACHABLE", started: false });
    expect(h.__pendingCountForTests()).toBe(0);
    await h.dispose();
  });

  it("release stops the helper without cleanup; the next exec respawns it", async () => {
    let cleaned = 0;
    const h = new HelperClient({
      transport: { kind: "tcp", host: "127.0.0.1", port: srv.port },
      privateKey: pair.private,
      onDispose: async () => { cleaned++; },
    });
    await h.exec("true", { timeoutMs: 5000 });
    await h.release();
    expect(cleaned).toBe(0);
    expect((await h.exec("echo back", { timeoutMs: 5000 })).stdout).toBe("back\n");
    await h.dispose();
    expect(cleaned).toBe(1);
  });

  it("dispose runs the cleanup hook before stopping the helper", async () => {
    const seen: string[] = [];
    const h = new HelperClient({
      transport: { kind: "tcp", host: "127.0.0.1", port: srv.port },
      privateKey: pair.private,
      onDispose: async (exec) => { seen.push((await exec("echo cleanup", { timeoutMs: 5000 })).stdout); },
    });
    await h.dispose();
    expect(seen).toEqual(["cleanup\n"]);
  });
});
