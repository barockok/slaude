import { describe, expect, test, afterEach } from "bun:test";
import { createV1Api } from "../../../src/gateway/api";
import { InMemoryPendingSource } from "../../../src/gateway/api/pending-source";
import { startHealthServer } from "../../../src/health";

const NODE_TOKEN = "pending-test-token";

const stubTools = {
  slackCtx: () => { throw new Error("unused"); },
  surfaceFor: () => { throw new Error("unused"); },
  surfaceOpts: () => { throw new Error("unused"); },
  connect: async () => "unused",
  brainDeps: () => undefined,
} as any;

describe("InMemoryPendingSource", () => {
  test("create/get/resolve/sweepExpired", async () => {
    const s = new InMemoryPendingSource();
    const row = await s.create("approval", "S1", { a: 1 }, Date.now() + 1000);
    expect((await s.get(row.id))?.status).toBe("pending");
    expect(await s.get("nope")).toBeNull();
    const resolved = await s.resolve(row.id, "denied", "U2");
    expect(resolved?.status).toBe("denied");
    expect(resolved?.resolvedBy).toBe("U2");
    // double-resolve is refused
    expect(await s.resolve(row.id, "approved", "U3")).toBeNull();
    const stale = await s.create("perm", "S1", {}, Date.now() - 1);
    expect(await s.sweepExpired()).toBe(1);
    expect((await s.get(stale.id))?.status).toBe("expired");
  });
});

describe("GET /v1/pending/:id long-poll", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterEach(() => {
    server?.stop(true);
    server = undefined;
    delete process.env.SLAUDE_NODE_TOKEN;
  });

  test("times out with 204 when nothing settles inside the window", async () => {
    process.env.SLAUDE_NODE_TOKEN = NODE_TOKEN;
    const source = new InMemoryPendingSource();
    const v1 = createV1Api({ tools: stubTools, pendingSource: source, pending: { timeoutMs: 200, pollMs: 40 } });
    server = Bun.serve({ port: 0, fetch: async (req) => (await v1.fetch(req)) ?? new Response(null, { status: 404 }) });
    const row = await source.create("approval", "S1", {}, Date.now() + 60_000);
    const t0 = Date.now();
    const r = await fetch(`http://127.0.0.1:${server.port}/v1/pending/${row.id}`, {
      headers: { authorization: `Bearer ${NODE_TOKEN}` },
    });
    expect(r.status).toBe(204);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
  });
});

describe("health server /v1 mount", () => {
  let health: ReturnType<typeof startHealthServer> = null;
  afterEach(() => {
    health?.stop();
    health = null;
    process.env.SLAUDE_HEALTH_PORT = "0";
    delete process.env.SLAUDE_NODE_TOKEN;
  });

  test("routes /v1/* to the injected handler; /healthz still served; no handler → 404", async () => {
    process.env.SLAUDE_NODE_TOKEN = NODE_TOKEN;
    const port = 21000 + Math.floor(Math.random() * 900);
    process.env.SLAUDE_HEALTH_PORT = String(port);
    const source = new InMemoryPendingSource();
    const v1 = createV1Api({ tools: stubTools, pendingSource: source });
    health = startHealthServer({ liveSessions: () => 0, v1: (req) => v1.fetch(req) });
    const ok = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(ok.status).toBe(200);
    const r = await fetch(`http://127.0.0.1:${port}/v1/pending/nope`, {
      headers: { authorization: `Bearer ${NODE_TOKEN}` },
    });
    expect(r.status).toBe(404); // reached the /v1 handler (unknown id), not the health 404 text
    expect(((await r.json()) as any).error).toContain("unknown pending id");
    health?.stop();

    // node role: server.ts passes no v1 handler → plain health 404
    const port2 = port + 1;
    process.env.SLAUDE_HEALTH_PORT = String(port2);
    health = startHealthServer({ liveSessions: () => 0 });
    const r2 = await fetch(`http://127.0.0.1:${port2}/v1/pending/nope`, {
      headers: { authorization: `Bearer ${NODE_TOKEN}` },
    });
    expect(r2.status).toBe(404);
    expect(await r2.text()).toBe("not found");
  });
});
