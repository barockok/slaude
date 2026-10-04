/**
 * The node's boot handshake and gate typing (node labels and routing spec
 * §4.2, §4.6): whoami exits only on 401, retries network errors and 5xx with
 * backoff, warns under 14 days; a gate 403 is GateDenied and never retried;
 * /v1/pending carries the job token.
 */
import { describe, expect, test } from "bun:test";
import { GateDenied, NodeApiError, NodeClient } from "../../src/node/client";
import { EXPIRY_WARN_SEC, nodeHandshake } from "../../src/node/handshake";
import { GATE_DENIED_CODE, GATE_DENIED_MESSAGE, JOB_HEADER } from "../../src/gateway/api/auth";

const SECRET_TOKEN = "node-credential-value-that-must-not-be-printed";

function fakeFetch(responses: Array<Response | Error>, seen: Request[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    seen.push(new Request(url, init));
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
}
const whoamiBody = (over: object = {}) =>
  Response.json({ id: "eng-a", labels: ["engineering"], legacy: false, expiresInSec: 60 * 86400, ...over });

function capture() {
  const logs: string[] = [];
  return { logs, log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) };
}

describe("nodeHandshake", () => {
  test("ok: logs the identity, no expiry warning past 14 days", async () => {
    const c = capture();
    const client = new NodeClient({ baseUrl: "http://gw", token: SECRET_TOKEN, fetchImpl: fakeFetch([whoamiBody()]) });
    const r = await nodeHandshake(client, { ...c, sleep: async () => {} });
    expect(r.ok && r.identity?.id).toBe("eng-a");
    expect(c.logs.join("\n")).toContain("labels=engineering");
    expect(c.logs.join("\n")).not.toContain("expires in");
  });

  test("warns when fewer than 14 days remain", async () => {
    const c = capture();
    const client = new NodeClient({
      baseUrl: "http://gw", token: SECRET_TOKEN, fetchImpl: fakeFetch([whoamiBody({ expiresInSec: EXPIRY_WARN_SEC - 86400 })]),
    });
    expect((await nodeHandshake(client, { ...c, sleep: async () => {} })).ok).toBe(true);
    expect(c.logs.join("\n")).toContain("expires in 13 day(s)");
  });

  test("401 → refuse with a clear message that never contains the token", async () => {
    const c = capture();
    const sleeps: number[] = [];
    const client = new NodeClient({
      baseUrl: "http://gw", token: SECRET_TOKEN,
      fetchImpl: fakeFetch([new Response(JSON.stringify({ error: "invalid or missing bearer token" }), { status: 401 })]),
    });
    const r = await nodeHandshake(client, { ...c, sleep: async (ms) => void sleeps.push(ms) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unauthorized");
      expect(r.message).toContain("401");
      expect(r.message).not.toContain(SECRET_TOKEN);
    }
    expect(sleeps).toEqual([]); // no retry
    expect(c.logs.join("\n")).not.toContain(SECRET_TOKEN);
  });

  test("network errors and 5xx are retried with backoff until the gateway answers", async () => {
    const c = capture();
    const sleeps: number[] = [];
    const seen: Request[] = [];
    const client = new NodeClient({
      baseUrl: "http://gw", token: SECRET_TOKEN, attempts: 1,
      fetchImpl: fakeFetch([new TypeError("connection refused"), new Response("down", { status: 503 }), new TypeError("dns"), whoamiBody()], seen),
    });
    const r = await nodeHandshake(client, { ...c, sleep: async (ms) => void sleeps.push(ms), baseDelayMs: 100, maxDelayMs: 300 });
    expect(r.ok).toBe(true);
    expect(sleeps).toEqual([100, 200, 300]);
    expect(seen.map((q) => new URL(q.url).pathname)).toEqual(Array(4).fill("/v1/node/whoami"));
    expect(c.logs.join("\n")).not.toContain(SECRET_TOKEN);
  });

  test("404 (a gateway older than whoami) continues", async () => {
    const c = capture();
    const client = new NodeClient({ baseUrl: "http://gw", token: SECRET_TOKEN, fetchImpl: fakeFetch([new Response("{}", { status: 404 })]) });
    const r = await nodeHandshake(client, { ...c, sleep: async () => {} });
    expect(r).toEqual({ ok: true, identity: null });
  });
});

describe("NodeClient gate typing", () => {
  const gate403 = () => new Response(JSON.stringify({ error: GATE_DENIED_MESSAGE, code: GATE_DENIED_CODE }), { status: 403 });

  test("a gate 403 raises GateDenied, once (never retried)", async () => {
    const seen: Request[] = [];
    const client = new NodeClient({ baseUrl: "http://gw", token: "t", attempts: 3, baseDelayMs: 1, fetchImpl: fakeFetch([gate403(), gate403(), gate403()], seen) });
    const e = await client.getRuntime("default", "default", "job").catch((x) => x);
    expect(e).toBeInstanceOf(GateDenied);
    expect(e).toBeInstanceOf(NodeApiError);
    expect(e.status).toBe(403);
    expect(seen).toHaveLength(1);
    const e2 = await new NodeClient({ baseUrl: "http://gw", token: "t", fetchImpl: fakeFetch([gate403()]) })
      .postTool("kb", "search_kbs", {}, "job")
      .catch((x) => x);
    expect(e2).toBeInstanceOf(GateDenied);
  });

  test("another 403 stays a plain NodeApiError", async () => {
    const other = new Response(JSON.stringify({ error: "job token is not scoped to this tenant" }), { status: 403 });
    const e = await new NodeClient({ baseUrl: "http://gw", token: "t", fetchImpl: fakeFetch([other]) })
      .getMcpCredentials("default", "job")
      .catch((x) => x);
    expect(e).toBeInstanceOf(NodeApiError);
    expect(e).not.toBeInstanceOf(GateDenied);
  });

  test("getPending sends the job token when given one; reissue posts the queue", async () => {
    const seen: Request[] = [];
    const client = new NodeClient({
      baseUrl: "http://gw", token: "t",
      fetchImpl: fakeFetch([new Response(null, { status: 204 }), new Response(null, { status: 204 }), Response.json({ jobToken: "new" })], seen),
    });
    expect(await client.getPending("P1", "job-tok")).toBe("timeout");
    expect(await client.getPending("P1")).toBe("timeout");
    expect(seen[0]!.headers.get(JOB_HEADER)).toBe("job-tok");
    expect(seen[1]!.headers.get(JOB_HEADER)).toBeNull();
    expect(await client.reissueJobToken("J1", "turns.node-1", "old")).toBe("new");
    expect(new URL(seen[2]!.url).pathname).toBe("/v1/jobs/J1/token-reissue");
    expect(seen[2]!.headers.get(JOB_HEADER)).toBe("old");
    expect(await seen[2]!.json()).toEqual({ queue: "turns.node-1" });
  });
});
