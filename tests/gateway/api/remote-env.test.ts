import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createV1Api } from "../../../src/gateway/api/index";
import { mintJobToken, JOB_HEADER } from "../../../src/gateway/api/auth";
import { __resetMasterKeyCache } from "../../../src/db/crypto";
import * as Envs from "../../../src/db/environments";
import * as OneOnOne from "../../../src/db/one-on-one";
import * as Remote from "../../../src/db/remote";
import { activeRemoteTarget } from "../../../src/remote/active";
import { ensureProvisioned } from "../../../src/remote/env-runtime";
import { registerKind, unregisterKind } from "../../../src/remote/kinds";
import { fakeSandboxKind } from "../../remote/fake-sandbox";

const NODE_TOKEN = "test-node-token";
const PATH = "/v1/tenants/t1/remote-env";
const tok = (over: Record<string, unknown> = {}) => mintJobToken({
  tenant: "t1", persona: "default", session: "S1", team: "T1", channel: "C1", thread: "1.1",
  initiator: "UTESTA", scope: "turn", runAs: "user:UTESTA", ...over,
} as any);
const get = (jobToken: string, path = PATH) => createV1Api({ tools: {} as any }).fetch(
  new Request(`http://gw${path}`, { headers: { authorization: `Bearer ${NODE_TOKEN}`, [JOB_HEADER]: jobToken } }),
);
const claimFor = async () => {
  const t = (await activeRemoteTarget("C1", "1.1"))!;
  return { addr: t.addr, dir: t.dir, env: t.env };
};

beforeAll(() => { process.env.SLAUDE_NODE_TOKEN = NODE_TOKEN; process.env.SLAUDE_JOB_SECRET = "test-job-secret"; });
beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 3).toString("base64");
  __resetMasterKeyCache();
  await Remote._wipeForTests();
  await OneOnOne._wipeForTests();
  await Remote.putKeyIfAbsent("T1", "UTESTA", { privateKey: "PRIV-A", publicKey: "PUB-A" });
});

describe("remote-env endpoint: user-machine", () => {
  beforeEach(async () => {
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.1", lockedUser: "UTESTA", createdBy: "UTESTA" });
    await Remote.setTarget({ channelId: "C1", threadTs: "1.1", teamId: "T1", userId: "UTESTA", addr: "tcA", dir: "/r", lockByRemote: true });
  });

  test("serves the transport and the owner's key for the owner's turn", async () => {
    const res = await get(tok({ remote: await claimFor() }));
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ transport: { kind: "tailcat", addr: "tcA" }, privateKey: "PRIV-A" });
  });
  test("refuses a turn that runs as someone else, or as the agent", async () => {
    const remote = await claimFor();
    expect((await get(tok({ remote, runAs: "user:UTESTB" })))!.status).toBe(403);
    expect((await get(tok({ remote, runAs: "agent" })))!.status).toBe(403);
  });
  test("refuses a stale claim: the environment was edited or the thread moved", async () => {
    const remote = await claimFor();
    const b = (await Envs.findBinding("C1", "1.1"))!;
    await Envs.updateEnv(b.env_id, { config: { addr: "tcB" } });
    const res = await get(tok({ remote }));
    expect(res!.status).toBe(409);
    expect(await res!.text()).not.toContain("PRIV");
  });
  test("refuses once the lock is gone (the trust class no longer applies)", async () => {
    const remote = await claimFor();
    await OneOnOne.unlock("C1", "1.1");
    expect((await get(tok({ remote })))!.status).toBe(409);
  });
  test("refuses without an environment claim, and on a tenant mismatch", async () => {
    expect((await get(tok({ remote: { addr: "tcA", dir: "/r" } })))!.status).toBe(403);
    expect((await get(tok({ remote: await claimFor() }), "/v1/tenants/other/remote-env"))!.status).toBe(403);
  });
});

describe("remote-env endpoint: provisioned sandbox", () => {
  beforeEach(() => registerKind(fakeSandboxKind()));
  afterEach(() => unregisterKind("sandbox"));

  test("serves the sandbox endpoint to an agent turn; 409 until it is provisioned", async () => {
    const e = await Envs.createEnv({ teamId: "T1", userId: "UTESTA", name: "sb", kind: "sandbox", config: { image: "img" } });
    await Envs.bind({ channelId: "C1", threadTs: "1.1", envId: e.id, dir: "/w", lockByEnv: false });
    expect((await get(tok({ runAs: "agent", remote: await claimFor() })))!.status).toBe(409);
    await ensureProvisioned("C1", "1.1");
    const res = await get(tok({ runAs: "agent", remote: await claimFor() }));
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ transport: { kind: "tcp", host: "127.0.0.1", port: 1 }, privateKey: "SB-KEY-1" });
  });
});
