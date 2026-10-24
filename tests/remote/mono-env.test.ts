import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as Envs from "../../src/db/environments";
import * as OneOnOne from "../../src/db/one-on-one";
import * as Remote from "../../src/db/remote";
import * as Sessions from "../../src/db/sessions";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import { defaultEnvDeps, handleEnvCommand } from "../../src/gateway/core/env-command";
import { registerKind, unregisterKind } from "../../src/remote/kinds";
import { makeMonoRemoteFactory, monoRemoteResolver } from "../../src/remote/mono";
import type { RemoteHandle } from "../../src/remote/types";
import { startTestSshServer, testKeyPair } from "./ssh-test-server";

/**
 * Mono, end to end: /env with the real pre-flight against an sshd, then the
 * resolver and factory the mono gateway installs on the agent, then a command
 * through the real helper subprocess.
 */
const pair = testKeyPair();
let srv: Awaited<ReturnType<typeof startTestSshServer>>;
let sessionId: string;
const replies: string[] = [];
const ctx = () => ({
  teamId: "T1", channelId: "C1", threadTs: "1.0", userId: "U_A", sessionId, isManager: false,
  reply: async (t: string) => { replies.push(t); },
  sayPrivately: async (t: string) => { replies.push(t); },
  reload: () => {},
});
const handles: RemoteHandle[] = [];
const open = async () => {
  const t = await monoRemoteResolver(sessionId);
  if (!t) return null;
  const h = await makeMonoRemoteFactory()(sessionId, t);
  handles.push(h);
  return { t, h };
};

beforeAll(async () => { srv = await startTestSshServer({ authorizedPublicKey: pair.public }); });
afterAll(async () => { await srv.stop(); });
beforeEach(async () => {
  process.env.SLAUDE_REMOTE = "1";
  process.env.SLAUDE_OUTBOUND_DEV_LOOPBACK = "1";
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 4).toString("base64");
  __resetMasterKeyCache();
  await OneOnOne._wipeForTests();
  await Remote._wipeForTests();
  replies.length = 0;
  const thread = { team_id: "T1", channel_id: "C1", thread_ts: "1.0" };
  sessionId = ((await Sessions.findByThread(thread)) ?? (await Sessions.createForThread({ thread, model: "m", working_dir: "/tmp" }))).id;
  await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: pair.private, publicKey: pair.public });
});
afterEach(async () => {
  for (const h of handles.splice(0)) await h.release();
  delete process.env.SLAUDE_REMOTE;
  delete process.env.SLAUDE_OUTBOUND_DEV_LOOPBACK;
});

describe("mono + environments", () => {
  it("ssh: /env add pins the host key, then the mono factory runs a command over the pinned connection", async () => {
    await handleEnvCommand(
      { kind: "env", action: "add", kindName: "ssh", name: "box", fields: { host: "127.0.0.1", user: "dev", port: String(srv.port) }, dir: "/" },
      ctx(),
      defaultEnvDeps,
    );
    expect(replies.join("\n")).toContain("Environment *box*");
    expect((await Envs.findEnvByName("T1", "U_A", "box"))!.config.hostKey).toMatch(/^SHA256:/);

    const o = (await open())!;
    expect(o.t.env).toMatchObject({ kind: "ssh", name: "box", trust: "user-machine" });
    const r = await o.h.exec("echo mono-ok", { timeoutMs: 10_000 });
    expect(r.stdout).toBe("mono-ok\n");
  });

  it("ssh: once the host key no longer matches, the mono helper refuses with REMOTE_HOST_CHANGED", async () => {
    await handleEnvCommand(
      { kind: "env", action: "add", kindName: "ssh", name: "box", fields: { host: "127.0.0.1", user: "dev", port: String(srv.port) }, dir: "/" },
      ctx(),
      defaultEnvDeps,
    );
    const e = (await Envs.findEnvByName("T1", "U_A", "box"))!;
    await Envs.updateEnv(e.id, { config: { ...e.config, hostKey: "SHA256:" + "Z".repeat(43) } });
    const o = (await open())!;
    await expect(o.h.exec("true", { timeoutMs: 10_000 })).rejects.toMatchObject({ code: "REMOTE_HOST_CHANGED" });
  });

  it("no target without the owner's lock; the factory refuses a target the thread moved off", async () => {
    await handleEnvCommand(
      { kind: "env", action: "add", kindName: "ssh", name: "box", fields: { host: "127.0.0.1", user: "dev", port: String(srv.port) }, dir: "/" },
      ctx(),
      defaultEnvDeps,
    );
    const t = (await monoRemoteResolver(sessionId))!;
    await Envs.clearBinding("C1", "1.0");
    await expect(makeMonoRemoteFactory()(sessionId, t)).rejects.toThrow("environment changed");
    await OneOnOne.unlock("C1", "1.0");
    expect(await monoRemoteResolver(sessionId)).toBeNull();
  });

  it("sandbox: unlocked thread, provisioned lazily by the mono factory, command runs in it", async () => {
    let provisions = 0;
    registerKind({
      kind: "sandbox", label: "Test sandbox", trust: "provisioned", fields: [],
      parse: () => ({ ok: true, config: {} }), setupGuide: () => "", status: async () => "running",
      provision: async () => {
        provisions++;
        return { transport: { kind: "tcp", host: "127.0.0.1", port: srv.port }, privateKey: pair.private };
      },
      teardown: async () => {},
    });
    try {
      const e = await Envs.createEnv({ teamId: "T1", userId: "U_A", name: "sb", kind: "sandbox", config: {} });
      await Envs.bind({ channelId: "C1", threadTs: "1.0", envId: e.id, dir: "/", lockByEnv: false });
      expect(await OneOnOne.find("C1", "1.0")).toBeNull();
      const o = (await open())!;
      expect(o.t.env?.trust).toBe("provisioned");
      expect((await o.h.exec("echo in-sandbox", { timeoutMs: 10_000 })).stdout).toBe("in-sandbox\n");
      expect(provisions).toBe(1);
    } finally {
      unregisterKind("sandbox");
    }
  });
});
