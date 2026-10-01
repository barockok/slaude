import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../../../src/db/schema";
import { __resetMasterKeyCache } from "../../../src/db/crypto";
import { createDeployApi, DEPLOY_MAX_BODY_BYTES } from "../../../src/gateway/deploy/api";
import { createV1Api } from "../../../src/gateway/api";
import { healthRoutes } from "../../../src/health";
import { __resetPersonaRegistry, whenPersonaRegistrySettled } from "../../../src/persona/registry";

const DEPLOY = "d".repeat(40);
const NODE = "n".repeat(40);
const url = "https://slaude.example.com/deploy/v1/tenants/default/personas";
const body = { revision: "r1", committedAt: "2026-10-01T10:00:00Z",
  personas: [{ name: "default", soul: "You are the default." }, { name: "ana", slackUserId: "UTESTUSER1", soul: "You are Ana.", userToken: "${PERSONA_ANA_XOXP}" }] };
const post = (token: string | null, b: unknown = body, q = "") =>
  new Request(url + q, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(b) });

const PREVIEW = "p".repeat(40);
const ENV_KEYS = ["SLAUDE_DEPLOY_TOKEN", "SLAUDE_DEPLOY_PREVIEW_TOKEN", "SLAUDE_NODE_TOKEN", "SLAUDE_MASTER_KEY"];
let prev: Record<string, string | undefined>;
beforeEach(async () => {
  prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.SLAUDE_DEPLOY_TOKEN = DEPLOY;
  process.env.SLAUDE_NODE_TOKEN = NODE;
  delete process.env.SLAUDE_DEPLOY_PREVIEW_TOKEN;
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  // The persona tables are Postgres-only (migration 0011).
  if (process.env.SLAUDE_DB !== "pg") return;
  for (const t of ["persona_overrides", "persona_sync_state", "personas"]) await db.run(`DELETE FROM ${t}`);
});
const pgOnly = describe.skipIf(process.env.SLAUDE_DB !== "pg");
afterEach(async () => {
  // A real sync's reload installs a database-backed snapshot: reset it.
  await whenPersonaRegistrySettled();
  __resetPersonaRegistry();
  for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  __resetMasterKeyCache();
});

const api = (pubsub: any = null) => createDeployApi({ pubsub, env: () => ({ PERSONA_ANA_XOXP: "user-token-secret-value" }), extract: async () => ({ approvers: [] }) });

pgOnly("POST /deploy/v1/tenants/:tenant/personas", () => {
  test("the deploy token applies a sync and reports it", async () => {
    const res = await api().fetch(post(DEPLOY));
    expect(res!.status).toBe(200);
    expect((await res!.json() as any).created).toEqual(["default", "ana"]);
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
    expect(text).toContain("PERSONA_ANA_XOXP");
  });

  test("a placeholder outside PERSONA_* is a 422 naming the variable; the gateway secret is never stored", async () => {
    const leak = { ...body, personas: [body.personas[0], { ...body.personas[1], mcp: { mcpServers: { x: { type: "http", url: "https://x.test/mcp", headers: { a: "${SLAUDE_MASTER_KEY}" } } } } }] };
    const res = await createDeployApi({ pubsub: null, env: () => ({ PERSONA_ANA_XOXP: "t", SLAUDE_MASTER_KEY: "master-key-secret-value" }), extract: async () => ({ approvers: [] }) })
      .fetch(post(DEPLOY, leak));
    expect(res!.status).toBe(422);
    const text = await res!.text();
    expect(text).toContain("SLAUDE_MASTER_KEY");
    expect(text).not.toContain("master-key-secret-value");
    expect(await db.query(`SELECT name FROM personas`)).toHaveLength(0);
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

pgOnly("token hardening and tenant guard", () => {
  const anyPath = () => new Request("https://slaude.example.com/deploy/anything", { headers: { authorization: "Bearer    " } });
  test("a whitespace-only deploy token is unset: every /deploy path 404s", async () => {
    process.env.SLAUDE_DEPLOY_TOKEN = " ".repeat(40);
    expect((await api().fetch(anyPath()))!.status).toBe(404);
    expect((await api().fetch(post(" ".repeat(40))))!.status).toBe(404);
  });
  test("a deploy token equal to the node token is unset, with one warning", async () => {
    const { env, __resetDeployTokenWarnings } = await import("../../../src/config/env");
    __resetDeployTokenWarnings();
    process.env.SLAUDE_DEPLOY_TOKEN = `  ${NODE} `;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await api().fetch(post(NODE)))!.status).toBe(404);
      expect((await api().fetch(post(NODE)))!.status).toBe(404);
      expect(env.deployToken()).toBe("");
      const hits = warn.mock.calls.filter((c) => c.map(String).join(" ").includes("SLAUDE_DEPLOY_TOKEN"));
      expect(hits).toHaveLength(1);
      expect(hits[0]!.map(String).join(" ")).not.toContain(NODE);
    } finally {
      warn.mockRestore();
    }
  });
  test("a preview token equal to the node token is unset too", async () => {
    const { env } = await import("../../../src/config/env");
    process.env.SLAUDE_DEPLOY_PREVIEW_TOKEN = NODE;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(env.deployPreviewToken()).toBe("");
    } finally {
      warn.mockRestore();
    }
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

pgOnly("the preview token (dry runs only)", () => {
  test("the preview token with dryRun=1 gets a report", async () => {
    process.env.SLAUDE_DEPLOY_PREVIEW_TOKEN = PREVIEW;
    const res = await api().fetch(post(PREVIEW, body, "?dryRun=1"));
    expect(res!.status).toBe(200);
    expect((await res!.json() as any).dryRun).toBe(true);
  });

  test("the preview token without dryRun is the same 401 as any bad token, and applies nothing", async () => {
    process.env.SLAUDE_DEPLOY_PREVIEW_TOKEN = PREVIEW;
    const res = await api().fetch(post(PREVIEW));
    const bad = await api().fetch(post("x".repeat(40)));
    expect(res!.status).toBe(401);
    expect(await res!.text()).toBe(await bad!.text());
    for (const q of ["?dryRun=0", "?dryRun=true", "?dryRun="]) {
      expect((await api().fetch(post(PREVIEW, body, q)))!.status).toBe(401);
    }
    expect(await db.query(`SELECT name FROM personas`)).toHaveLength(0);
  });

  test("the deploy token still does both", async () => {
    process.env.SLAUDE_DEPLOY_PREVIEW_TOKEN = PREVIEW;
    expect((await api().fetch(post(DEPLOY, body, "?dryRun=1")))!.status).toBe(200);
    expect((await api().fetch(post(DEPLOY)))!.status).toBe(200);
  });

  test("a preview token alone serves dry runs; a short or blank one is unset", async () => {
    delete process.env.SLAUDE_DEPLOY_TOKEN;
    process.env.SLAUDE_DEPLOY_PREVIEW_TOKEN = `  ${PREVIEW}\n`;
    expect((await api().fetch(post(PREVIEW, body, "?dryRun=1")))!.status).toBe(200);
    expect((await api().fetch(post(PREVIEW)))!.status).toBe(401);
    process.env.SLAUDE_DEPLOY_PREVIEW_TOKEN = "p".repeat(31);
    expect((await api().fetch(post("p".repeat(31), body, "?dryRun=1")))!.status).toBe(404);
  });

  test("a preview token equal to the deploy token is unset", async () => {
    process.env.SLAUDE_DEPLOY_PREVIEW_TOKEN = DEPLOY;
    // The value still works as the deploy token; it just is not a preview token.
    const { env } = await import("../../../src/config/env");
    expect(env.deployPreviewToken()).toBe("");
  });

  test("a dry run never calls the soul extractor", async () => {
    let calls = 0;
    const a = createDeployApi({ pubsub: null, env: () => ({ PERSONA_ANA_XOXP: "user-token-secret-value" }), extract: async () => { calls++; return { approvers: [] }; } });
    const res = await a.fetch(post(DEPLOY, body, "?dryRun=1"));
    expect(res!.status).toBe(200);
    expect((await res!.json() as any).created).toEqual(["default", "ana"]);
    expect(calls).toBe(0);
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

// R42 (M3): the persona tables are Postgres-only. On sqlite an authorized sync
// used to 500 ("internal") on a missing table; it is a clear 409 instead.
describe.skipIf(process.env.SLAUDE_DB === "pg")("/deploy on sqlite", () => {
  test("an authorized sync or dry run is 409 'persona sync requires Postgres'", async () => {
    for (const q of ["", "?dryRun=1"]) {
      const res = await api().fetch(post(DEPLOY, body, q));
      expect(res!.status).toBe(409);
      expect(((await res!.json()) as any).error).toMatch(/persona sync requires Postgres/);
    }
  });
  test("auth still comes first: a wrong token is 401", async () => {
    expect((await api().fetch(post("x".repeat(40))))!.status).toBe(401);
  });
});

// R42 (T6): the preview token deliberately lives in workflows that run
// unreviewed pull-request code, so the body /deploy buffers is capped.
pgOnly("/deploy body cap", () => {
  test("a body over the cap is 413 and is not applied", async () => {
    const big = { ...body, padding: "x".repeat(DEPLOY_MAX_BODY_BYTES) };
    const res = await api().fetch(post(DEPLOY, big));
    expect(res!.status).toBe(413);
    expect((await db.query("SELECT name FROM personas")).length).toBe(0);
  });
  test("a declared Content-Length over the cap is 413 without reading the body", async () => {
    const req = new Request(url, {
      method: "POST",
      headers: { authorization: `Bearer ${DEPLOY}`, "content-type": "application/json", "content-length": String(DEPLOY_MAX_BODY_BYTES + 1) },
      body: JSON.stringify(body),
    });
    expect((await api().fetch(req))!.status).toBe(413);
  });
  test("an unauthenticated oversized body is 401, never read", async () => {
    const res = await api().fetch(post(null, { ...body, padding: "x".repeat(DEPLOY_MAX_BODY_BYTES) }));
    expect(res!.status).toBe(401);
  });
});
