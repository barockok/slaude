/**
 * NodeClient: bearer/job headers, retry policy (5xx/network yes, 4xx never),
 * ETag runtime cache, tool-plane 404 folding. Runs against a local Bun.serve
 * stub — no gateway, no Redis.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NodeClient, NodeApiError } from "../../src/node/client";
import { JOB_HEADER } from "../../src/gateway/api/auth";

type Seen = { path: string; method: string; auth: string | null; job: string | null; inm: string | null };

let server: ReturnType<typeof Bun.serve>;
let base = "";
const seen: Seen[] = [];
let flaky5xxLeft = 0;
let runtimeVersion = 1;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      seen.push({
        path: url.pathname,
        method: req.method,
        auth: req.headers.get("authorization"),
        job: req.headers.get(JOB_HEADER),
        inm: req.headers.get("if-none-match"),
      });
      if (url.pathname === "/v1/flaky") {
        if (flaky5xxLeft > 0) {
          flaky5xxLeft--;
          return new Response("boom", { status: 503 });
        }
        return Response.json({ ok: true });
      }
      if (url.pathname === "/v1/bad") return new Response(JSON.stringify({ error: "nope" }), { status: 400 });
      if (url.pathname === "/v1/sessions/s1") {
        return Response.json({ id: "s1", model: "m", status: "idle" });
      }
      if (url.pathname === "/v1/sessions/missing") return new Response("{}", { status: 404 });
      if (url.pathname === "/v1/tenants/default/runtime") {
        const etag = `"v${runtimeVersion}"`;
        if (req.headers.get("if-none-match") === etag) {
          return new Response(null, { status: 304, headers: { etag } });
        }
        return new Response(JSON.stringify({ tenantId: "default", personaId: "default", version: runtimeVersion }), {
          status: 200,
          headers: { "content-type": "application/json", etag },
        });
      }
      if (url.pathname === "/v1/pending/timeout") return new Response(null, { status: 204 });
      if (url.pathname === "/v1/pending/done") {
        return Response.json({ status: "approved", payload: {}, resolvedBy: "U1" });
      }
      if (url.pathname === "/v1/pending/nope") return new Response("{}", { status: 404 });
      if (url.pathname === "/v1/tools/surface/reply") {
        return Response.json({ content: [{ type: "text", text: "posted ref=1.1" }] });
      }
      if (url.pathname === "/v1/tools/surface/unknown") {
        return new Response(JSON.stringify({ error: "unknown tool 'surface/unknown'" }), { status: 404 });
      }
      return new Response("nf", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server?.stop(true));

function client(over: Partial<ConstructorParameters<typeof NodeClient>[0]> = {}) {
  return new NodeClient({ baseUrl: base, token: "tok", attempts: 3, baseDelayMs: 1, ...over });
}

describe("NodeClient", () => {
  test("sends bearer on every request, job token when given", async () => {
    seen.length = 0;
    await client().getSession("s1", "jwt-1");
    expect(seen[0]!.auth).toBe("Bearer tok");
    expect(seen[0]!.job).toBe("jwt-1");
  });

  test("retries 5xx with backoff, then succeeds", async () => {
    seen.length = 0;
    flaky5xxLeft = 2;
    const res = await client().request("/v1/flaky");
    expect(res.status).toBe(200);
    expect(seen.filter((s) => s.path === "/v1/flaky").length).toBe(3);
  });

  test("gives up after attempts on persistent 5xx", async () => {
    flaky5xxLeft = 99;
    const res = await client({ attempts: 2 }).request("/v1/flaky");
    expect(res.status).toBe(503);
    flaky5xxLeft = 0;
  });

  test("never retries 4xx", async () => {
    seen.length = 0;
    const res = await client().request("/v1/bad");
    expect(res.status).toBe(400);
    expect(seen.filter((s) => s.path === "/v1/bad").length).toBe(1);
  });

  test("retries network errors up to attempts", async () => {
    // Unroutable port — connection refused.
    const c = new NodeClient({ baseUrl: "http://127.0.0.1:1", token: "t", attempts: 2, baseDelayMs: 1 });
    await expect(c.request("/v1/x")).rejects.toThrow();
  });

  test("json helper throws NodeApiError on non-ok", async () => {
    await expect(client().patchSession("missing", { status: "idle" }, "j")).rejects.toThrow(NodeApiError);
  });

  test("getSession maps 404 to null", async () => {
    expect(await client().getSession("missing", "j")).toBeNull();
  });

  test("runtime bundle: ETag cache serves 304 from cache; bust refetches", async () => {
    seen.length = 0;
    const c = client();
    const b1 = (await c.getRuntime("default", "j")) as any;
    expect(b1.version).toBe(1);
    const b2 = (await c.getRuntime("default", "j")) as any;
    expect(b2.version).toBe(1); // served via 304 + cache
    const reqs = seen.filter((s) => s.path === "/v1/tenants/default/runtime");
    expect(reqs[1]!.inm).toBe('"v1"');
    // Gateway config changed → new etag → fresh bundle.
    runtimeVersion = 2;
    const b3 = (await c.getRuntime("default", "j")) as any;
    expect(b3.version).toBe(2);
    // bust drops the cache → next request sends no If-None-Match.
    c.bustRuntime("default");
    seen.length = 0;
    await c.getRuntime("default", "j");
    expect(seen[0]!.inm).toBeNull();
  });

  test("getPending maps 204/404/200", async () => {
    const c = client();
    expect(await c.getPending("timeout")).toBe("timeout");
    expect(await c.getPending("nope")).toBe("notfound");
    expect(((await c.getPending("done")) as any).status).toBe("approved");
  });

  test("postTool returns MCP result verbatim; folds 404 into isError", async () => {
    const c = client();
    const ok = await c.postTool("surface", "reply", { text: "hi" }, "j");
    expect(ok.content[0]!.text).toBe("posted ref=1.1");
    const nf = await c.postTool("surface", "unknown", {}, "j");
    expect(nf.isError).toBe(true);
    expect(nf.content[0]!.text).toContain("tool unavailable");
  });
});
