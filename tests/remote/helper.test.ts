import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { utils } from "ssh2";
import { HelperClient } from "../../src/remote/helper-client";
import { startTestSshServer } from "./ssh-test-server";

const pair = utils.generateKeyPairSync("ed25519");
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
    const bad = utils.generateKeyPairSync("ed25519");
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
