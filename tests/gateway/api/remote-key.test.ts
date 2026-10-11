import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createV1Api } from "../../../src/gateway/api/index";
import { mintJobToken, JOB_HEADER } from "../../../src/gateway/api/auth";
import { __resetMasterKeyCache } from "../../../src/db/crypto";
import * as Remote from "../../../src/db/remote";

const NODE_TOKEN = "test-node-token";
const PATH = "/v1/tenants/t1/remote-key";
const tok = (over: Record<string, unknown> = {}) => mintJobToken({
  tenant: "t1", persona: "default", session: "S1", team: "T1", channel: "C1", thread: "1.1",
  initiator: "UTESTA", scope: "turn", runAs: "user:UTESTA", remote: { addr: "tcA", dir: "/r" }, ...over,
} as any);
const get = (jobToken: string, path = PATH) => createV1Api({ tools: {} as any }).fetch(
  new Request(`http://gw${path}`, { headers: { authorization: `Bearer ${NODE_TOKEN}`, [JOB_HEADER]: jobToken } }),
);

beforeAll(() => { process.env.SLAUDE_NODE_TOKEN = NODE_TOKEN; process.env.SLAUDE_JOB_SECRET = "test-job-secret"; });
beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 3).toString("base64");
  __resetMasterKeyCache();
  await Remote._wipeForTests();
  await Remote.putKeyIfAbsent("T1", "UTESTA", { privateKey: "PRIV-A", publicKey: "PUB-A" });
});

describe("remote-key endpoint", () => {
  test("serves the runAs user's key when the claims carry remote", async () => {
    const res = await get(tok());
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ privateKey: "PRIV-A" });
  });
  test("refuses without a remote claim", async () => {
    const res = await get(tok({ remote: undefined }));
    expect(res!.status).toBe(403);
    expect(await res!.text()).not.toContain("PRIV");
  });
  test("refuses an agent-scoped token", async () => {
    expect((await get(tok({ runAs: "agent" })))!.status).toBe(403);
  });
  test("refuses a token with no runAs", async () => {
    expect((await get(tok({ runAs: undefined })))!.status).toBe(403);
  });
  test("refuses a malformed runAs", async () => {
    expect((await get(tok({ runAs: "user:" })))!.status).toBe(403);
  });
  test("404 when that user has no key (another user's key is never served)", async () => {
    const res = await get(tok({ runAs: "user:UTESTB", initiator: "UTESTB" }));
    expect(res!.status).toBe(404);
    const body = await res!.text();
    expect(body).not.toContain("PRIV");
    expect(body).not.toContain("tcA");
  });
  test("tenant mismatch → 403", async () => {
    expect((await get(tok(), "/v1/tenants/other/remote-key"))!.status).toBe(403);
  });
  test("non-GET is refused", async () => {
    const res = await createV1Api({ tools: {} as any }).fetch(
      new Request(`http://gw${PATH}`, { method: "POST", headers: { authorization: `Bearer ${NODE_TOKEN}`, [JOB_HEADER]: tok() } }),
    );
    expect(res!.status).toBe(405);
  });
});
