/**
 * The provider proxy: the header swap per credential form, one upstream, no
 * redirect followed, rotation without a restart, and the real credential in
 * nothing that comes back to the box.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOX_CREDENTIAL_PLACEHOLDER, type ProviderForm } from "../../src/box/env";
import { credentialHeader, scrubStream, startProviderProxy, upstreamUrl, type ProviderProxy } from "../../src/box/egress/llm";
import { startFakeApi, type FakeApi } from "../spike/fake-messages-api";

const REAL = "real-provider-credential-0123456789abcdef";
let dir: string;
let proxy: ProviderProxy | null = null;
let n = 0;
type Seen = { path: string; headers: Record<string, string>; body: string };
let seen: Seen[] = [];
let respond: (req: Request, s: Seen) => Response | Promise<Response> = () => new Response("ok");
let upstream: ReturnType<typeof Bun.serve>;
let other: ReturnType<typeof Bun.serve>;
let otherHits = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "slaude-llm-"));
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const s: Seen = { path: u.pathname + u.search, headers: Object.fromEntries(req.headers), body: await req.text() };
      seen.push(s);
      return respond(req, s);
    },
  });
  other = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => (otherHits++, new Response("other host")) });
});

afterEach(async () => {
  await proxy?.close();
  proxy = null;
  seen = [];
  respond = () => new Response("ok");
});

afterAll(() => {
  upstream.stop(true);
  other.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const sock = () => join(dir, `l${n++}.sock`);
const via = (p: ProviderProxy, path: string, init: RequestInit = {}) => fetch(`http://box.invalid${path}`, { ...init, unix: p.socketPath } as RequestInit);
const start = (form: ProviderForm, value: () => string = () => REAL) =>
  startProviderProxy({ socketPath: sock(), upstream: `http://127.0.0.1:${upstream.port}`, credential: () => ({ form, value: value() }) });

describe("provider proxy", () => {
  const forms: Array<[ProviderForm, string, string, string]> = [
    ["api-key", "x-api-key", BOX_CREDENTIAL_PLACEHOLDER, REAL],
    ["auth-token", "authorization", `Bearer ${BOX_CREDENTIAL_PLACEHOLDER}`, `Bearer ${REAL}`],
    ["oauth-token", "authorization", `Bearer ${BOX_CREDENTIAL_PLACEHOLDER}`, `Bearer ${REAL}`],
  ];
  for (const [form, header, sent, want] of forms) {
    test(`${form}: the placeholder is replaced in ${header}, and no other credential header reaches the provider`, async () => {
      proxy = await start(form);
      const r = await via(proxy, "/v1/messages?beta=true", {
        method: "POST",
        headers: { [header]: sent, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20", cookie: "a=b", "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [] }),
      });
      expect(r.status).toBe(200);
      const got = seen.at(-1)!;
      expect(got.path).toBe("/v1/messages?beta=true");
      expect(got.headers[header]).toBe(want);
      const others = ["x-api-key", "authorization", "cookie", "anthropic-auth-token"].filter((h) => h !== header);
      for (const h of others) expect(got.headers[h]).toBeUndefined();
      // The CLI's own headers pass through untouched.
      expect(got.headers["anthropic-version"]).toBe("2023-06-01");
      expect(got.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
      expect(JSON.stringify(got)).not.toContain(BOX_CREDENTIAL_PLACEHOLDER);
      expect(got.body).toContain('"model":"m"');
    });
  }

  test("a credential the box sent in the wrong header is removed too", async () => {
    proxy = await start("api-key");
    await via(proxy, "/v1/messages", { method: "POST", headers: { authorization: "Bearer something-else", "x-api-key": "another" }, body: "{}" });
    expect(seen.at(-1)!.headers.authorization).toBeUndefined();
    expect(seen.at(-1)!.headers["x-api-key"]).toBe(REAL);
  });

  test("the real credential appears in no response: header, body, across a chunk boundary", async () => {
    respond = () => {
      const half = Math.floor(REAL.length / 2);
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(enc.encode(`you sent ${REAL.slice(0, half)}`));
          await new Promise((r) => setTimeout(r, 20));
          c.enqueue(enc.encode(`${REAL.slice(half)} and again ${REAL}.`));
          c.close();
        },
      });
      return new Response(body, { status: 401, headers: { "x-echo": `key=${REAL}`, "x-request-id": "req_1", "set-cookie": "s=1" } });
    };
    proxy = await start("api-key");
    const r = await via(proxy, "/v1/messages", { method: "POST", body: "{}" });
    const text = await r.text();
    expect(r.status).toBe(401);
    expect(text).toBe("you sent [redacted] and again [redacted].");
    expect(JSON.stringify([...r.headers])).not.toContain(REAL);
    expect(r.headers.get("x-echo")).toBeNull();
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(r.headers.get("x-request-id")).toBe("req_1");
  });

  test("a redirect is refused: not followed, and its target is never told to the box", async () => {
    respond = () => new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${other.port}/steal` } });
    proxy = await start("auth-token");
    const before = otherHits;
    const r = await via(proxy, "/v1/messages", { method: "POST", body: "{}" });
    expect(r.status).toBe(502);
    expect(r.headers.get("location")).toBeNull();
    expect(await r.text()).not.toContain(String(other.port));
    expect(otherHits).toBe(before);
  });

  test("one upstream: an absolute target for another host is served by the provider as a path", async () => {
    proxy = await start("api-key");
    const before = otherHits;
    const raw = await new Promise<string>((resolve, reject) => {
      const s = require("node:net").connect(proxy!.socketPath);
      let buf = "";
      s.on("error", reject);
      s.on("data", (d: Buffer) => (buf += d.toString()));
      s.on("close", () => resolve(buf));
      s.write(`GET http://127.0.0.1:${other.port}/example/repo.git HTTP/1.1\r\nhost: 127.0.0.1:${other.port}\r\nconnection: close\r\n\r\n`);
    });
    expect(otherHits).toBe(before);
    expect(raw).not.toContain("other host");
    if (seen.length) expect(seen.at(-1)!.path).toBe("/example/repo.git");
  });

  test("a rotated credential is used by the next request, with no restart", async () => {
    let current = REAL;
    proxy = await start("api-key", () => current);
    await via(proxy, "/v1/messages", { method: "POST", body: "{}" });
    current = "rotated-credential-fedcba9876543210";
    await via(proxy, "/v1/messages", { method: "POST", body: "{}" });
    expect(seen.map((s) => s.headers["x-api-key"])).toEqual([REAL, "rotated-credential-fedcba9876543210"]);
  });

  test("no credential, or an unreachable provider, is a 502 that says nothing about either", async () => {
    proxy = await startProviderProxy({
      socketPath: sock(),
      upstream: `http://127.0.0.1:${upstream.port}`,
      credential: () => {
        throw new Error(`the secret store said ${REAL}`);
      },
    });
    const a = await via(proxy, "/v1/messages", { method: "POST", body: "{}" });
    expect(a.status).toBe(502);
    expect(await a.text()).not.toContain(REAL);
    expect(seen).toHaveLength(0);
    await proxy.close();
    proxy = await startProviderProxy({ socketPath: sock(), upstream: "http://127.0.0.1:1", credential: () => ({ form: "api-key", value: REAL }) });
    const b = await via(proxy, "/v1/messages", { method: "POST", body: "{}" });
    expect(b.status).toBe(502);
    expect(await b.text()).not.toContain(REAL);
  });

  test("a request that gets no answer on its first connection is sent once more, and only once", async () => {
    let calls = 0;
    const bodies: string[] = [];
    proxy = await startProviderProxy({
      socketPath: sock(),
      upstream: `http://127.0.0.1:${upstream.port}`,
      credential: () => ({ form: "api-key", value: REAL }),
      fetch: (async (url: string, init: RequestInit) => {
        calls++;
        bodies.push(new TextDecoder().decode(init.body as Uint8Array));
        if (calls === 1) throw new Error("socket closed before a response");
        return fetch(url, init);
      }) as unknown as typeof fetch,
    });
    const r = await via(proxy, "/v1/messages", { method: "POST", headers: { "x-api-key": BOX_CREDENTIAL_PLACEHOLDER }, body: '{"model":"m"}' });
    expect(r.status).toBe(200);
    expect(calls).toBe(2);
    expect(bodies).toEqual(['{"model":"m"}', '{"model":"m"}']);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers["x-api-key"]).toBe(REAL);
    // A second failure is a 502, not a third try.
    calls = -10;
    await proxy.close();
    let tries = 0;
    proxy = await startProviderProxy({
      socketPath: sock(),
      upstream: `http://127.0.0.1:${upstream.port}`,
      credential: () => ({ form: "api-key", value: REAL }),
      fetch: (async () => {
        tries++;
        throw new Error("down");
      }) as unknown as typeof fetch,
    });
    expect((await via(proxy, "/v1/messages", { method: "POST", body: "{}" })).status).toBe(502);
    expect(tries).toBe(2);
  });

  test("a streamed tool loop of the fake Messages API passes through", async () => {
    const api: FakeApi = startFakeApi({ name: "Bash", input: { command: "echo hi" } });
    try {
      proxy = await startProviderProxy({ socketPath: sock(), upstream: api.url, credential: () => ({ form: "api-key", value: REAL }) });
      const first = await via(proxy, "/v1/messages", { method: "POST", headers: { "x-api-key": BOX_CREDENTIAL_PLACEHOLDER, "content-type": "application/json" }, body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "go" }] }) });
      expect(first.headers.get("content-type")).toContain("text/event-stream");
      const text = await first.text();
      expect(text).toContain("event: message_start");
      expect(text).toContain('"name":"Bash"');
      expect(text).not.toContain(REAL);
      expect(api.requests).toBe(1);
      expect(proxy.requests()).toBe(1);
    } finally {
      api.stop();
    }
  });
});

describe("provider proxy helpers", () => {
  test("upstreamUrl keeps the base's origin and prefix and takes only the path and query of the request", () => {
    expect(upstreamUrl("https://api.example.com", "http://box.invalid/v1/messages?beta=true")).toBe("https://api.example.com/v1/messages?beta=true");
    expect(upstreamUrl("https://api.example.com/proxy/", "/v1/messages")).toBe("https://api.example.com/proxy/v1/messages");
    expect(upstreamUrl("https://api.example.com", "http://evil.example.net:9/x")).toBe("https://api.example.com/x");
    expect(() => upstreamUrl("file:///etc/passwd", "/x")).toThrow();
  });

  test("credentialHeader", () => {
    expect(credentialHeader({ form: "api-key", value: "k" })).toEqual(["x-api-key", "k"]);
    expect(credentialHeader({ form: "auth-token", value: "k" })).toEqual(["authorization", "Bearer k"]);
    expect(credentialHeader({ form: "oauth-token", value: "k" })).toEqual(["authorization", "Bearer k"]);
  });

  test("scrubStream finds a secret split at every possible boundary", async () => {
    const secret = "s3cr3t-value";
    const text = `before ${secret} middle ${secret}${secret} after`;
    for (let cut = 1; cut < text.length; cut++) {
      const src = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(text.slice(0, cut)));
          c.enqueue(new TextEncoder().encode(text.slice(cut)));
          c.close();
        },
      });
      const out = await new Response(src.pipeThrough(scrubStream(secret))).text();
      expect(out).toBe("before [redacted] middle [redacted][redacted] after");
    }
  });
});
