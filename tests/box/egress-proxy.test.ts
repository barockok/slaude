/**
 * The egress proxy against local servers: allowed, refused by default, the
 * node's own services, private and mixed (rebinding) answers, a rule change
 * that ends an open tunnel, and plain HTTP forwarded with nothing added.
 *
 * A CONNECT tunnel is opaque bytes to the proxy, so a TCP echo stands in for a
 * TLS server here; no certificate is involved.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer as createHttpServer, type IncomingHttpHeaders, type Server as HttpServer } from "node:http";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTarget, startEgressProxy, type EgressProxy, type EgressRefusal } from "../../src/box/egress/proxy";
import type { BoxEgress } from "../../src/box/policy";

let dir: string;
let echo: Server;
let echoPort: number;
let web: HttpServer;
let webPort: number;
const webSeen: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
let proxy: EgressProxy | null = null;
let n = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "slaude-egress-"));
  echo = createServer((s) => {
    s.on("error", () => {});
    s.on("data", (d) => s.write(d));
  });
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
  echoPort = (echo.address() as AddressInfo).port;
  web = createHttpServer((req, res) => {
    webSeen.push({ url: req.url ?? "", headers: req.headers });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("plain ok");
  });
  await new Promise<void>((r) => web.listen(0, "127.0.0.1", () => r()));
  webPort = (web.address() as AddressInfo).port;
});

afterEach(async () => {
  await proxy?.close();
  proxy = null;
});

afterAll(() => {
  echo.close();
  web.close();
  rmSync(dir, { recursive: true, force: true });
});

const sock = () => join(dir, `e${n++}.sock`);

/** Send a head on the proxy socket; resolve with the response head and the live socket. */
function open(socketPath: string, head: string): Promise<{ status: number; text: string; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const s = connect(socketPath);
    let buf = "";
    s.on("error", reject);
    const onData = (d: Buffer) => {
      buf += d.toString("latin1");
      const at = buf.indexOf("\r\n\r\n");
      if (at < 0) return;
      s.off("data", onData);
      resolve({ status: Number(buf.split(" ")[1]), text: buf, socket: s });
    };
    s.on("data", onData);
    s.on("close", () => resolve({ status: Number(buf.split(" ")[1] ?? 0), text: buf, socket: s }));
    s.write(head);
  });
}
const connectHead = (target: string) => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`;
const rules = (allow: string[], deny: string[] = []): (() => BoxEgress) => () => ({ allow, deny });
const toEcho = () => ({ host: "127.0.0.1", port: echoPort });

describe("egress proxy", () => {
  test("an allowed CONNECT becomes an opaque tunnel", async () => {
    const allowed: string[] = [];
    proxy = await startEgressProxy({ socketPath: sock(), rules: rules(["code-host.example.com"]), dial: toEcho, onAllow: (e) => allowed.push(`${e.host}:${e.port}`) });
    const r = await open(proxy.socketPath, connectHead("code-host.example.com:443"));
    expect(r.status).toBe(200);
    const got = await new Promise<string>((resolve) => {
      r.socket.once("data", (d) => resolve(d.toString()));
      r.socket.write("ping-through-the-tunnel");
    });
    expect(got).toBe("ping-through-the-tunnel");
    expect(allowed).toEqual(["code-host.example.com:443"]);
    expect(proxy.open()).toEqual(["code-host.example.com:443"]);
    r.socket.destroy();
  });

  test("the socket is connectable by another user (the sandbox's)", async () => {
    proxy = await startEgressProxy({ socketPath: sock(), rules: rules([]) });
    expect(statSync(proxy.socketPath).mode & 0o777).toBe(0o666);
  });

  test("refused by default: a 403 with one plain sentence, and the dial never happens", async () => {
    const refused: Array<{ host: string; reason: EgressRefusal }> = [];
    let dialed = 0;
    proxy = await startEgressProxy({ socketPath: sock(), rules: rules([]), dial: () => (dialed++, toEcho()), onRefuse: (e) => refused.push({ host: e.host, reason: e.reason }) });
    const r = await open(proxy.socketPath, connectHead("example.com:443"));
    expect(r.status).toBe(403);
    const body = r.text.slice(r.text.indexOf("\r\n\r\n") + 4).trim();
    expect(body.split("\n")).toHaveLength(1);
    expect(body).toContain("example.com is not on this box's allowlist");
    expect(dialed).toBe(0);
    expect(refused).toEqual([{ host: "example.com", reason: "not-allowlisted" }]);
  });

  test("deny wins, and a port outside the entry is refused", async () => {
    proxy = await startEgressProxy({ socketPath: sock(), rules: rules(["*.example.com", "example.com"], ["uploads.example.com"]), dial: toEcho });
    expect((await open(proxy.socketPath, connectHead("uploads.example.com:443"))).status).toBe(403);
    expect((await open(proxy.socketPath, connectHead("example.com:22"))).status).toBe(403);
    const ok = await open(proxy.socketPath, connectHead("files.example.com:443"));
    expect(ok.status).toBe(200);
    ok.socket.destroy();
  });

  test("the node's own services are refused whatever the rules say", async () => {
    const refused: EgressRefusal[] = [];
    let dialed = 0;
    proxy = await startEgressProxy({
      socketPath: sock(),
      rules: rules(["gateway.internal.example:*", "redis.internal.example:*"]),
      refuseHosts: ["gateway.internal.example", "Redis.Internal.Example"],
      dial: () => (dialed++, toEcho()),
      onRefuse: (e) => refused.push(e.reason),
    });
    expect((await open(proxy.socketPath, connectHead("gateway.internal.example:8080"))).status).toBe(403);
    expect((await open(proxy.socketPath, connectHead("redis.internal.example:6379"))).status).toBe(403);
    expect(dialed).toBe(0);
    expect(refused).toEqual(["node-service", "node-service"]);
  });

  test("a name that resolves to a private, loopback or metadata address is refused even when allowlisted", async () => {
    const answers: Record<string, string[]> = {
      "private.example.com": ["10.1.2.3"],
      "loop.example.com": ["127.0.0.1"],
      "meta.example.com": ["169.254.169.254"],
      "v6.example.com": ["::1"],
    };
    const refused: EgressRefusal[] = [];
    proxy = await startEgressProxy({
      socketPath: sock(),
      rules: rules(["*.example.com", "127.0.0.1", "10.1.2.3"]),
      resolver: async (h) => (answers[h] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
      onRefuse: (e) => refused.push(e.reason),
    });
    for (const h of Object.keys(answers)) expect((await open(proxy.socketPath, connectHead(`${h}:443`))).status).toBe(403);
    // An IP literal is not resolved, and is checked the same way.
    expect((await open(proxy.socketPath, connectHead("127.0.0.1:443"))).status).toBe(403);
    expect((await open(proxy.socketPath, connectHead("10.1.2.3:443"))).status).toBe(403);
    expect(new Set(refused)).toEqual(new Set(["private-address"]));
  });

  test("a rebinding attempt: one private answer among public ones refuses the name, and the name is resolved once", async () => {
    let lookups = 0;
    proxy = await startEgressProxy({
      socketPath: sock(),
      rules: rules(["rebind.example.com"]),
      resolver: async () => {
        lookups++;
        return [{ address: "93.184.216.34", family: 4 }, { address: "192.168.1.10", family: 4 }];
      },
    });
    expect((await open(proxy.socketPath, connectHead("rebind.example.com:443"))).status).toBe(403);
    expect(lookups).toBe(1);
  });

  test("a name that does not resolve is a 502, not a hang", async () => {
    proxy = await startEgressProxy({ socketPath: sock(), rules: rules(["gone.example.com"]), resolver: async () => [] });
    expect((await open(proxy.socketPath, connectHead("gone.example.com:443"))).status).toBe(502);
  });

  test("rules that cannot be read refuse the connection", async () => {
    proxy = await startEgressProxy({
      socketPath: sock(),
      rules: () => {
        throw new Error("bundle unavailable");
      },
      dial: toEcho,
    });
    expect((await open(proxy.socketPath, connectHead("example.com:443"))).status).toBe(403);
  });

  test("a rule change reaches the next connection, and closeDisallowed ends a tunnel the new rules refuse", async () => {
    let allow = ["a.example.com", "b.example.com"];
    proxy = await startEgressProxy({ socketPath: sock(), rules: () => ({ allow, deny: [] }), dial: toEcho });
    const a = await open(proxy.socketPath, connectHead("a.example.com:443"));
    const b = await open(proxy.socketPath, connectHead("b.example.com:443"));
    expect([a.status, b.status]).toEqual([200, 200]);
    const aClosed = new Promise<void>((r) => a.socket.once("close", () => r()));
    allow = ["b.example.com"];
    expect(await proxy.closeDisallowed()).toBe(1);
    await aClosed;
    expect(proxy.open()).toEqual(["b.example.com:443"]);
    // The tunnel still allowed keeps working, and the removed host is refused from now on.
    const got = await new Promise<string>((resolve) => {
      b.socket.once("data", (d) => resolve(d.toString()));
      b.socket.write("still here");
    });
    expect(got).toBe("still here");
    expect((await open(proxy.socketPath, connectHead("a.example.com:443"))).status).toBe(403);
    b.socket.destroy();
  });

  test("plain HTTP is forwarded in origin form with the proxy hop headers removed and nothing added", async () => {
    proxy = await startEgressProxy({ socketPath: sock(), rules: rules(["registry.example.com"]), dial: () => ({ host: "127.0.0.1", port: webPort }) });
    const r = await open(
      proxy.socketPath,
      "GET http://registry.example.com/v2/pkg?x=1 HTTP/1.1\r\nHost: registry.example.com\r\nProxy-Connection: keep-alive\r\nProxy-Authorization: Basic Ym94OmJveA==\r\nUser-Agent: test/1\r\n\r\n",
    );
    expect(r.status).toBe(200);
    const got = webSeen.at(-1)!;
    expect(got.url).toBe("/v2/pkg?x=1");
    expect(got.headers.host).toBe("registry.example.com");
    expect(got.headers["proxy-authorization"]).toBeUndefined();
    expect(got.headers["proxy-connection"]).toBeUndefined();
    expect(got.headers.authorization).toBeUndefined();
    expect(got.headers["user-agent"]).toBe("test/1");
  });

  test("what is neither CONNECT nor plain http is a 400", async () => {
    proxy = await startEgressProxy({ socketPath: sock(), rules: rules(["example.com"]), dial: toEcho });
    for (const head of ["GET /relative HTTP/1.1\r\nHost: example.com\r\n\r\n", "GET https://example.com/ HTTP/1.1\r\n\r\n", "GET http://user:pw@example.com/ HTTP/1.1\r\n\r\n", "CONNECT example.com HTTP/1.1\r\n\r\n", "garbage\r\n\r\n"]) {
      expect((await open(proxy.socketPath, head)).status).toBe(400);
    }
  });
});

describe("parseTarget", () => {
  test("CONNECT wants host:port", () => {
    expect(parseTarget("CONNECT", "Example.com:443")).toEqual({ host: "example.com", port: 443, path: null });
    expect(parseTarget("CONNECT", "[2001:db8::1]:443")).toEqual({ host: "2001:db8::1", port: 443, path: null });
    expect(parseTarget("CONNECT", "example.com")).toBeNull();
    expect(parseTarget("CONNECT", "example.com:443/x")).toBeNull();
  });
  test("plain http in absolute form", () => {
    expect(parseTarget("GET", "http://example.com:8080/a?b=1")).toEqual({ host: "example.com", port: 8080, path: "/a?b=1" });
    expect(parseTarget("GET", "http://example.com")).toEqual({ host: "example.com", port: 80, path: "/" });
    expect(parseTarget("GET", "/a")).toBeNull();
    expect(parseTarget("GET", "ftp://example.com/")).toBeNull();
  });
});
