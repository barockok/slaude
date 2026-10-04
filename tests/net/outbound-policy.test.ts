import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OutboundBlockedError,
  checkOutbound,
  classifyAddress,
  safeFetch,
  type Resolver,
} from "../../src/net/outbound-policy";

/** Resolver that records the hosts it was asked for and answers from a table. */
function fakeResolver(table: Record<string, string[]>): Resolver & { calls: string[] } {
  const calls: string[] = [];
  const r = (async (host: string) => {
    calls.push(host);
    const addrs = table[host];
    if (!addrs) throw new Error(`ENOTFOUND ${host}`);
    return addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  }) as Resolver & { calls: string[] };
  r.calls = calls;
  return r;
}

describe("classifyAddress", () => {
  const blocked: Array<[string, string]> = [
    ["127.0.0.1", "loopback"],
    ["127.255.0.9", "loopback"],
    ["::1", "loopback"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "private"],
    ["fc00::1", "private"],
    ["fd00:ec2::254", "metadata"],
    ["100.100.100.200", "metadata"],
    ["fd00::1", "private"],
    ["169.254.169.254", "link-local"],
    ["169.254.0.1", "link-local"],
    ["fe80::1", "link-local"],
    ["fe80::1%en0", "link-local"],
    ["0.0.0.0", "unspecified"],
    ["::", "unspecified"],
    ["224.0.0.1", "reserved"],
    ["255.255.255.255", "reserved"],
    ["ff02::1", "reserved"],
    ["192.0.2.10", "reserved"],
    ["2001:db8::1", "reserved"],
    // IPv4 embedded in IPv6: judged by the IPv4 address it carries.
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["::ffff:169.254.169.254", "link-local"],
    ["::ffff:10.0.0.1", "private"],
    ["64:ff9b::a9fe:a9fe", "link-local"],
    ["2002:7f00:1::", "loopback"],
    ["::127.0.0.1", "loopback"],
    // IPv4-translated (::ffff:0:0:0/96, RFC 2765) and local-use NAT64 (64:ff9b:1::/48, RFC 8215).
    ["::ffff:0:7f00:1", "loopback"],
    ["::ffff:0:a9fe:a9fe", "link-local"],
    ["64:ff9b:1::a00:1", "private"],
    ["64:ff9b:1::7f00:1", "loopback"],
    // Local-use NAT64 only ever reaches the operator's own network.
    ["64:ff9b:1::5db8:d822", "private"],
  ];
  for (const [ip, kind] of blocked) {
    test(`${ip} is ${kind}`, () => expect(classifyAddress(ip)).toBe(kind as never));
  }

  for (const ip of ["93.184.216.34", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:93.184.216.34"]) {
    test(`${ip} is public`, () => expect(classifyAddress(ip)).toBeNull());
  }

  test("garbage is refused rather than treated as public", () => {
    expect(classifyAddress("not-an-ip")).toBe("invalid");
    expect(classifyAddress("1.2.3")).toBe("invalid");
    expect(classifyAddress("1:2:3")).toBe("invalid");
  });
});

describe("checkOutbound", () => {
  const strict = { allowLoopback: false, allowedHosts: [], internalHosts: [] };

  test("only https is allowed", async () => {
    const resolver = fakeResolver({ "example.com": ["93.184.216.34"] });
    for (const url of ["http://example.com/x", "ftp://example.com/x", "file:///etc/passwd", "gopher://example.com/"]) {
      await expect(checkOutbound(url, { ...strict, resolver })).rejects.toBeInstanceOf(OutboundBlockedError);
    }
    expect(resolver.calls).toEqual([]);
  });

  test("an unparseable URL is refused", async () => {
    await expect(checkOutbound("not a url", strict)).rejects.toThrow(/invalid URL/);
  });

  test("literal private, loopback, link-local and metadata addresses are refused without DNS", async () => {
    const resolver = fakeResolver({});
    for (const url of [
      "https://127.0.0.1/",
      "https://[::1]/",
      "https://10.0.0.8/token",
      "https://192.168.0.1/",
      "https://169.254.169.254/latest/meta-data/",
      "https://[fd00:ec2::254]/",
      "https://[::ffff:169.254.169.254]/",
      "https://[fe80::1]/",
    ]) {
      await expect(checkOutbound(url, { ...strict, resolver })).rejects.toThrow(/refused/);
    }
    expect(resolver.calls).toEqual([]);
  });

  test("a hostname that resolves to a private address is refused (DNS rebinding)", async () => {
    const resolver = fakeResolver({
      "rebind.example.com": ["10.0.0.5"],
      "metadata.example.com": ["169.254.169.254"],
      "mixed.example.com": ["93.184.216.34", "127.0.0.1"],
      "mapped.example.com": ["::ffff:127.0.0.1"],
    });
    for (const host of ["rebind.example.com", "metadata.example.com", "mixed.example.com", "mapped.example.com"]) {
      const err = await checkOutbound(`https://${host}/`, { ...strict, resolver }).catch((e) => e);
      expect(err).toBeInstanceOf(OutboundBlockedError);
      // The message names the host and the category, never the resolved address.
      expect((err as Error).message).toContain(host);
      expect((err as Error).message).not.toMatch(/10\.0\.0\.5|169\.254|127\.0\.0\.1/);
    }
  });

  test("the system resolver is the default", async () => {
    const ok = await checkOutbound("http://localhost:1/", { ...strict, allowLoopback: true });
    expect(ok.addresses.length).toBeGreaterThan(0);
  });

  test("a hostname that does not resolve, or resolves to nothing, is refused", async () => {
    const resolver = fakeResolver({ "empty.example.com": [] });
    await expect(checkOutbound("https://nx.example.com/", { ...strict, resolver })).rejects.toThrow(/could not be resolved/);
    await expect(checkOutbound("https://empty.example.com/", { ...strict, resolver })).rejects.toThrow(/could not be resolved/);
  });

  test("a public https host passes and returns the checked addresses", async () => {
    const resolver = fakeResolver({ "auth.example.com": ["93.184.216.34", "2606:4700::1111"] });
    const ok = await checkOutbound("https://auth.example.com/token", { ...strict, resolver });
    expect(ok.addresses.map((a) => a.address)).toEqual(["93.184.216.34", "2606:4700::1111"]);
    expect(ok.url.hostname).toBe("auth.example.com");
  });

  test("the operator allowlist narrows: unlisted hosts are refused before DNS", async () => {
    const resolver = fakeResolver({ "auth.example.com": ["93.184.216.34"], "api.example.com": ["93.184.216.34"], "other.example.org": ["93.184.216.34"] });
    const opts = { ...strict, resolver, allowedHosts: ["auth.example.com", "*.example.com"] };
    await expect(checkOutbound("https://AUTH.example.com/", opts)).resolves.toBeDefined();
    await expect(checkOutbound("https://api.example.com/", opts)).resolves.toBeDefined();
    await expect(checkOutbound("https://other.example.org/", opts)).rejects.toThrow(/not in SLAUDE_OUTBOUND_ALLOWED_HOSTS/);
    expect(resolver.calls).not.toContain("other.example.org");
  });

  test("the allowlist never admits a private address", async () => {
    const resolver = fakeResolver({ "auth.example.com": ["10.0.0.1"] });
    await expect(checkOutbound("https://auth.example.com/", { ...strict, resolver, allowedHosts: ["auth.example.com"] })).rejects.toThrow(/private/);
  });

  test("the dev loopback flag admits loopback (http too), and nothing else", async () => {
    const resolver = fakeResolver({ "localhost": ["127.0.0.1", "::1"], "rebind.example.com": ["10.0.0.5"], "example.com": ["93.184.216.34"] });
    const dev = { ...strict, resolver, allowLoopback: true };
    await expect(checkOutbound("http://localhost:8080/", dev)).resolves.toBeDefined();
    await expect(checkOutbound("http://127.0.0.1:8080/", dev)).resolves.toBeDefined();
    await expect(checkOutbound("https://rebind.example.com/", dev)).rejects.toThrow(/private/);
    await expect(checkOutbound("https://169.254.169.254/", dev)).rejects.toThrow(/link-local/);
    // http stays loopback-only even with the flag.
    await expect(checkOutbound("http://example.com/", dev)).rejects.toThrow(/https/);
  });

  test("operator-declared internal hosts may resolve to private ranges and use http, never to link-local or loopback", async () => {
    const resolver = fakeResolver({
      "idp.cluster.test": ["10.0.0.7"],
      "evil.cluster.test": ["169.254.169.254"],
      "lo.cluster.test": ["127.0.0.1"],
      "idp2.cluster.test": ["10.0.0.8"],
    });
    const opts = { ...strict, resolver, internalHosts: ["idp.cluster.test", "evil.cluster.test", "lo.cluster.test"] };
    await expect(checkOutbound("http://idp.cluster.test:8080/token", opts)).resolves.toBeDefined();
    await expect(checkOutbound("https://evil.cluster.test/", opts)).rejects.toThrow(/link-local/);
    await expect(checkOutbound("https://lo.cluster.test/", opts)).rejects.toThrow(/loopback/);
    await expect(checkOutbound("https://idp2.cluster.test/", opts)).rejects.toThrow(/private/);
  });

  test("internal hosts are still refused the cloud metadata addresses inside private and shared ranges", async () => {
    const resolver = fakeResolver({
      "md4.cluster.test": ["100.100.100.200"],
      "md6.cluster.test": ["fd00:ec2::254"],
      "md-mapped.cluster.test": ["::ffff:100.100.100.200"],
    });
    const opts = { ...strict, resolver, internalHosts: ["md4.cluster.test", "md6.cluster.test", "md-mapped.cluster.test"] };
    for (const host of ["md4.cluster.test", "md6.cluster.test", "md-mapped.cluster.test"]) {
      await expect(checkOutbound(`https://${host}/`, opts)).rejects.toThrow(/metadata/);
    }
  });

  describe("environment defaults", () => {
    const saved = { ...process.env };
    afterEach(() => {
      for (const k of ["SLAUDE_OUTBOUND_ALLOWED_HOSTS", "SLAUDE_OUTBOUND_INTERNAL_HOSTS", "SLAUDE_OUTBOUND_DEV_LOOPBACK"]) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    });

    test("SLAUDE_OUTBOUND_ALLOWED_HOSTS, SLAUDE_OUTBOUND_INTERNAL_HOSTS and SLAUDE_OUTBOUND_DEV_LOOPBACK are read when not passed", async () => {
      const resolver = fakeResolver({ "a.example.com": ["93.184.216.34"], "b.example.com": ["93.184.216.34"], "idp.cluster.test": ["10.0.0.7"], "localhost": ["127.0.0.1"] });
      process.env.SLAUDE_OUTBOUND_ALLOWED_HOSTS = "a.example.com, idp.cluster.test,localhost";
      process.env.SLAUDE_OUTBOUND_INTERNAL_HOSTS = "idp.cluster.test";
      await expect(checkOutbound("https://a.example.com/", { resolver })).resolves.toBeDefined();
      await expect(checkOutbound("https://b.example.com/", { resolver })).rejects.toThrow(/ALLOWED_HOSTS/);
      await expect(checkOutbound("http://idp.cluster.test/", { resolver })).resolves.toBeDefined();
      await expect(checkOutbound("http://localhost/", { resolver })).rejects.toBeInstanceOf(OutboundBlockedError);
      process.env.SLAUDE_OUTBOUND_DEV_LOOPBACK = "1";
      await expect(checkOutbound("http://localhost/", { resolver })).resolves.toBeDefined();
    });
  });
});

describe("safeFetch (against a local server, loopback admitted by the dev flag)", () => {
  let hits: string[] = [];
  let release: () => void = () => {};
  const hang = new Promise<void>((r) => { release = r; });
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req): Promise<Response> {
      const u = new URL(req.url);
      hits.push(`${req.method} ${u.pathname} host=${req.headers.get("host")} auth=${req.headers.get("authorization") ?? ""}`);
      if (u.pathname === "/json") return Response.json({ ok: true, body: await req.text() }, { headers: { "x-test": "1" } });
      if (u.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${server.port}/secret` } });
      if (u.pathname === "/big") return new Response("x".repeat(5000));
      if (u.pathname === "/hang") { await hang; return new Response("late"); }
      if (u.pathname === "/text") return new Response("not json");
      return new Response("nope", { status: 404 });
    },
  });
  afterAll(() => { release(); server.stop(true); });
  afterEach(() => { hits = []; });
  const base = (host = "127.0.0.1") => `http://${host}:${server.port}`;
  const dev = (extra: Record<string, unknown> = {}) => ({ allowLoopback: true, allowedHosts: [], internalHosts: [], ...extra });

  test("connects to the checked address, not a re-resolved one", async () => {
    // .test never resolves in real DNS; reaching the server proves the
    // connection used the address the policy checked.
    const resolver = fakeResolver({ "svc.example.test": ["127.0.0.1"] });
    const res = await safeFetch(`${base("svc.example.test")}/json`, { method: "POST", headers: { "content-type": "text/plain" }, body: "hello" }, dev({ resolver }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-test")).toBe("1");
    expect(await res.json()).toEqual({ ok: true, body: "hello" });
    expect(resolver.calls).toEqual(["svc.example.test"]);
    expect(hits[0]).toContain(`host=svc.example.test:${server.port}`);
  });

  test("redirects are not followed and the credential is not replayed", async () => {
    const res = await safeFetch(`${base()}/redirect`, { headers: { authorization: "Bearer test-token" } }, dev());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/secret");
    expect(hits).toHaveLength(1);
    expect(hits.some((h) => h.includes("/secret"))).toBe(false);
  });

  test("without the dev flag the same loopback server is refused before connecting", async () => {
    await expect(safeFetch(`${base()}/json`, {}, { allowLoopback: false, allowedHosts: [], internalHosts: [] })).rejects.toBeInstanceOf(OutboundBlockedError);
    expect(hits).toHaveLength(0);
  });

  test("a response over the size cap is refused", async () => {
    await expect(safeFetch(`${base()}/big`, {}, dev({ maxResponseBytes: 1000 }))).rejects.toThrow(/exceeded 1000 bytes/);
  });

  test("a server that never answers times out", async () => {
    await expect(safeFetch(`${base()}/hang`, {}, dev({ timeoutMs: 100 }))).rejects.toThrow(/timed out after 100ms/);
  });

  test("text() returns the body and json() on a non-JSON body rejects", async () => {
    const res = await safeFetch(`${base()}/text`, {}, dev());
    expect(await res.text()).toBe("not json");
    await expect(res.json()).rejects.toThrow();
  });

  test("a transport failure on a pinned address names the host, never the address", async () => {
    // TLS against the plain-http server: the handshake fails on the pinned
    // address. Bun's raw message embeds the IP it connected to; the error can
    // be posted into a Slack thread, so only the hostname may appear.
    const resolver = fakeResolver({ "idp.example.test": ["127.0.0.1"] });
    const err = await safeFetch(`https://idp.example.test:${server.port}/x`, {}, dev({ resolver })).then(() => new Error("resolved"), (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^request to idp\.example\.test failed \([A-Za-z0-9_]+\)$/);
    expect(err.message).not.toContain("127.0.0.1");
  });

  const hasOpenssl = Bun.which("openssl") !== null;
  test.skipIf(!hasOpenssl)("a TLS certificate failure on a pinned address names the host, never the address", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slaude-tls-"));
    try {
      const gen = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-subj", "/CN=svc.example.test",
        "-addext", "subjectAltName=DNS:svc.example.test"], { stderr: "pipe" });
      expect(gen.exitCode).toBe(0);
      const tls = Bun.serve({
        port: 0, hostname: "127.0.0.1",
        tls: { cert: readFileSync(join(dir, "c.pem"), "utf8"), key: readFileSync(join(dir, "k.pem"), "utf8") },
        fetch: () => new Response("ok"),
      });
      try {
        // Self-signed and the wrong name: the raw runtime error reads
        // `… fetching "https://127.0.0.1:<port>/x"`.
        const resolver = fakeResolver({ "other.example.test": ["127.0.0.1"] });
        const err = await safeFetch(`https://other.example.test:${tls.port}/x`, {}, dev({ resolver })).then(() => new Error("resolved"), (e: Error) => e);
        expect(err.message).toMatch(/^request to other\.example\.test failed \([A-Za-z0-9_]+\)$/);
        expect(err.message).not.toContain("127.0.0.1");
      } finally {
        tls.stop(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("documented: an env proxy (HTTP_PROXY) is honoured and receives the pinned address", async () => {
    // Bun's node:http has no per-request opt-out from env proxies, so the
    // policy cannot ignore them; the module header and the configuration
    // reference say the trust boundary moves to the proxy. If Bun stops
    // honouring the variable, this fails and those docs need revisiting.
    const proxyHits: string[] = [];
    const proxy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => { proxyHits.push(r.url); return new Response("via-proxy"); } });
    try {
      const code = `
        const { safeFetch } = await import(${JSON.stringify(join(import.meta.dir, "../../src/net/outbound-policy.ts"))});
        const res = await safeFetch("http://svc.example.test:${server.port}/json", {}, {
          allowLoopback: true, allowedHosts: [], internalHosts: [],
          resolver: async () => [{ address: "127.0.0.1", family: 4 }],
        });
        console.log(await res.text());`;
      const proxyUrl = `http://127.0.0.1:${proxy.port}`;
      const env: Record<string, string | undefined> = { ...process.env, HTTP_PROXY: proxyUrl, http_proxy: proxyUrl };
      delete env.NO_PROXY; delete env.no_proxy;
      const p = Bun.spawn([process.execPath, "-e", code], { env, stdout: "pipe", stderr: "pipe" });
      const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
      expect(out.trim()).toBe("via-proxy");
      expect(proxyHits).toEqual([`http://127.0.0.1:${server.port}/json`]);
    } finally {
      proxy.stop(true);
    }
  });

  test("a connection failure surfaces as an error", async () => {
    const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = closed.port;
    closed.stop(true);
    await expect(safeFetch(`http://127.0.0.1:${port}/`, {}, dev())).rejects.toThrow();
  });
});
