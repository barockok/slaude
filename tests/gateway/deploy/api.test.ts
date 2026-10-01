import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../../src/db/schema";
import { __resetMasterKeyCache } from "../../../src/db/crypto";
import { createDeployApi } from "../../../src/gateway/deploy/api";
import { createV1Api } from "../../../src/gateway/api";
import { healthRoutes } from "../../../src/health";

const DEPLOY = "d".repeat(40);
const NODE = "n".repeat(40);
const url = "https://slaude.example.com/deploy/v1/tenants/default/personas";
const body = { revision: "r1", committedAt: "2026-10-01T10:00:00Z",
  personas: [{ name: "ana", slackUserId: "UTESTUSER1", soul: "You are Ana.", userToken: "${ANA_XOXP}" }] };
const post = (token: string | null, b: unknown = body, q = "") =>
  new Request(url + q, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(b) });

const ENV_KEYS = ["SLAUDE_DEPLOY_TOKEN", "SLAUDE_NODE_TOKEN", "SLAUDE_MASTER_KEY"];
let prev: Record<string, string | undefined>;
beforeEach(async () => {
  prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.SLAUDE_DEPLOY_TOKEN = DEPLOY;
  process.env.SLAUDE_NODE_TOKEN = NODE;
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  for (const t of ["persona_overrides", "persona_sync_state", "personas"]) await db.run(`DELETE FROM ${t}`);
});
afterEach(() => {
  for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  __resetMasterKeyCache();
});

const api = (pubsub: any = null) => createDeployApi({ pubsub, env: () => ({ ANA_XOXP: "user-token-secret-value" }), extract: async () => ({ approvers: [] }) });

describe("POST /deploy/v1/tenants/:tenant/personas", () => {
  test("the deploy token applies a sync and reports it", async () => {
    const res = await api().fetch(post(DEPLOY));
    expect(res!.status).toBe(200);
    expect((await res!.json() as any).created).toEqual(["ana"]);
  });

  test("without a configured deploy token every /deploy path is 404, before auth", async () => {
    delete process.env.SLAUDE_DEPLOY_TOKEN;
    expect((await api().fetch(post(DEPLOY)))!.status).toBe(404);
    expect((await api().fetch(post(null)))!.status).toBe(404);
    expect((await api().fetch(new Request("https://slaude.example.com/deploy/anything")))!.status).toBe(404);
  });

  test("a wrong token, no token, and the node token are all the same 401", async () => {
    const a = await api().fetch(post("x".repeat(40)));
    const b = await api().fetch(post(null));
    const c = await api().fetch(post(NODE));
    expect([a!.status, b!.status, c!.status]).toEqual([401, 401, 401]);
    expect(await a!.text()).toBe(await c!.text());
  });

  test("the deploy token cannot call /v1", async () => {
    const v1 = createV1Api({ tools: {} as any });
    const res = await v1.fetch(new Request("https://slaude.example.com/v1/pending/x", { headers: { authorization: `Bearer ${DEPLOY}` } }));
    expect(res!.status).toBe(401);
  });

  test("dryRun=1 applies nothing and does not publish a reload", async () => {
    let published = 0;
    const pubsub = { publishReload: async () => { published++; return 1; } };
    const res = await api(pubsub).fetch(post(DEPLOY, body, "?dryRun=1"));
    expect((await res!.json() as any).dryRun).toBe(true);
    expect(await db.query(`SELECT name FROM personas`)).toHaveLength(0);
    expect(published).toBe(0);
  });

  test("a real sync publishes a reload", async () => {
    let published = 0;
    const pubsub = { publishReload: async () => { published++; return 1; } };
    await api(pubsub).fetch(post(DEPLOY));
    expect(published).toBe(1);
  });

  test("failures map to their statuses, and no secret value reaches the body", async () => {
    const res = await createDeployApi({ pubsub: null, env: () => ({}), extract: async () => ({ approvers: [] }) }).fetch(post(DEPLOY));
    expect(res!.status).toBe(422);
    const text = await res!.text();
    expect(text).toContain("ANA_XOXP");
  });

  test("a successful sync never echoes the resolved token", async () => {
    const res = await api().fetch(post(DEPLOY));
    expect(await res!.text()).not.toContain("user-token-secret-value");
  });

  test("only POST is allowed", async () => {
    const res = await api().fetch(new Request(url, { headers: { authorization: `Bearer ${DEPLOY}` } }));
    expect(res!.status).toBe(405);
  });

  test("non-/deploy paths fall through", async () => {
    expect(await api().fetch(new Request("https://slaude.example.com/v1/x"))).toBeNull();
  });
});

describe("token hardening and tenant guard", () => {
  const anyPath = () => new Request("https://slaude.example.com/deploy/anything", { headers: { authorization: "Bearer    " } });
  test("a whitespace-only deploy token is unset: every /deploy path 404s", async () => {
    process.env.SLAUDE_DEPLOY_TOKEN = " ".repeat(40);
    expect((await api().fetch(anyPath()))!.status).toBe(404);
    expect((await api().fetch(post(" ".repeat(40))))!.status).toBe(404);
  });
  test("a 31-character token is unset", async () => {
    process.env.SLAUDE_DEPLOY_TOKEN = "s".repeat(31);
    expect((await api().fetch(post("s".repeat(31))))!.status).toBe(404);
  });
  test("surrounding whitespace in the env is trimmed", async () => {
    process.env.SLAUDE_DEPLOY_TOKEN = `  ${DEPLOY}\n`;
    expect((await api().fetch(post(DEPLOY)))!.status).toBe(200);
  });
  test("malformed or slash-bearing tenant escapes 404, not 500", async () => {
    for (const t of ["%E0", "a%2Fb", "Bad_Tenant"]) {
      const r = new Request(`https://slaude.example.com/deploy/v1/tenants/${t}/personas`, { method: "POST", headers: { authorization: `Bearer ${DEPLOY}` }, body: "{}" });
      expect((await api().fetch(r))!.status).toBe(404);
    }
  });
});

describe("health mounting", () => {
  test("/deploy is served only when deps.deploy is provided", async () => {
    const req = () => post(DEPLOY);
    const without = await healthRoutes({ liveSessions: () => 0 })(req());
    expect(without).toBeNull();
    const withDeploy = await healthRoutes({ liveSessions: () => 0, deploy: async () => new Response("hit", { status: 200 }) })(req());
    expect(withDeploy!.status).toBe(200);
  });
});
