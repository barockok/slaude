/**
 * The explicit non-goal of the box design (plan, Phase 8; spec, "What 'no
 * secrets' means for tools"): there is NO credential-adding route from a box
 * to a code host or a package registry. The provider proxy is the only place
 * a credential is added, and only for the provider's own upstream.
 *
 *   1. The egress proxy adds no header. What a box sent is what the upstream
 *      receives: no Authorization, no token, no cookie, no proxy credential.
 *   2. The provider proxy adds exactly one credential header, for exactly one
 *      upstream. Asked for any other host it adds nothing and forwards nothing.
 *
 * These assertions were written before the two proxies existed, against the
 * interface the plan describes: an HTTP proxy on a Unix socket per session
 * with rules read from a supplier, and a reverse proxy on a Unix socket with
 * one upstream and a credential read from the bundle. The proxies
 * (src/box/egress/proxy.ts and src/box/egress/llm.ts) took the option names
 * used here, so the three lines marked ADAPT needed no change. The assertions
 * are as first written; only the request helper changed (see viaSocket). The
 * skip below stays as a guard: it can only fire if a proxy module is deleted.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EGRESS_MODULE = join(import.meta.dir, "../../src/box/egress/proxy.ts");
const PROVIDER_MODULE = join(import.meta.dir, "../../src/box/egress/llm.ts");
const present = existsSync(EGRESS_MODULE) && existsSync(PROVIDER_MODULE);
const WHY_SKIPPED = "skipped: src/box/egress/ (box plan, Phase 2) does not exist yet";
const name = (what: string) => (present ? what : `${what} [${WHY_SKIPPED}]`);

/** The value that must never leave the node worker for anything but the provider. */
const REAL_CREDENTIAL = "real-provider-credential-for-this-test";
/** Header names a credential could ride in. None may be ADDED by the egress proxy. */
const CREDENTIAL_HEADERS = ["authorization", "proxy-authorization", "x-api-key", "cookie", "x-auth-token", "private-token", "x-goog-api-key", "x-registry-auth"];

type Seen = { host: string; path: string; headers: IncomingHttpHeaders };
type Running = { close(): Promise<void> | void };

/** A local HTTP server that records what reached it. */
function recorder(): Promise<{ server: Server; port: number; seen: Seen[] }> {
  return new Promise((resolve) => {
    const seen: Seen[] = [];
    const server = createServer((req, res) => {
      seen.push({ host: req.headers.host ?? "", path: req.url ?? "", headers: req.headers });
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port, seen }));
  });
}

/** One HTTP request over a Unix socket. `target` is the request target as written (absolute form for a forward proxy). */
function viaSocket(socketPath: string, target: string, headers: Record<string, string>): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  // Written on a raw socket: Bun's node:http reads an absolute request target as "use a proxy" and refuses that over a Unix socket.
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    let raw = Buffer.alloc(0);
    sock.on("error", reject);
    sock.on("data", (d: Buffer) => (raw = Buffer.concat([raw, d])));
    sock.on("close", () => {
      const text = raw.toString("utf8");
      const cut = text.indexOf("\r\n\r\n");
      const head = (cut < 0 ? text : text.slice(0, cut)).split("\r\n");
      const got: IncomingHttpHeaders = {};
      for (const line of head.slice(1)) {
        const at = line.indexOf(":");
        if (at > 0) got[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
      }
      resolve({ status: Number((head[0] ?? "").split(" ")[1] ?? 0), headers: got, body: cut < 0 ? "" : text.slice(cut + 4) });
    });
    sock.write(`GET ${target} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("")}connection: close\r\n\r\n`);
  });
}

describe.skipIf(!present)(name("no credential route from a box"), () => {
  let dir: string;
  let codeHost: Awaited<ReturnType<typeof recorder>>;
  let provider: Awaited<ReturnType<typeof recorder>>;
  let egress: Running;
  let llm: Running;
  let egressSock: string;
  let llmSock: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "slaude-box-proxies-"));
    egressSock = join(dir, "egress.sock");
    llmSock = join(dir, "llm.sock");
    codeHost = await recorder();
    provider = await recorder();
    const egressMod = (await import(EGRESS_MODULE)) as Record<string, (o: unknown) => Promise<Running> | Running>;
    const llmMod = (await import(PROVIDER_MODULE)) as Record<string, (o: unknown) => Promise<Running> | Running>;
    // ADAPT (1): how the egress proxy is started. An allowlisted host, dialed at the local recorder.
    egress = await egressMod.startEgressProxy!({
      socketPath: egressSock,
      rules: () => ({ allow: ["code-host.example.com", "registry.example.com"], deny: [] }),
      // ADAPT (2): the seam that lets a test stand a local server in for an allowlisted public host.
      dial: (_host: string, _port: number) => ({ host: "127.0.0.1", port: codeHost.port }),
    });
    // ADAPT (3): how the provider proxy is started. One upstream, one credential, read per request.
    llm = await llmMod.startProviderProxy!({
      socketPath: llmSock,
      upstream: `http://127.0.0.1:${provider.port}`,
      credential: () => ({ form: "api-key", value: REAL_CREDENTIAL }),
    });
  });

  afterAll(async () => {
    await egress?.close();
    await llm?.close();
    codeHost?.server.close();
    provider?.server.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("the egress proxy adds no header: a request with none of its own reaches the upstream with none", async () => {
    const r = await viaSocket(egressSock, "http://code-host.example.com/example/repo.git/info/refs", { host: "code-host.example.com", "user-agent": "git/2.47" });
    expect(r.status).toBe(200);
    const got = codeHost.seen.at(-1)!;
    for (const h of CREDENTIAL_HEADERS) expect(got.headers[h]).toBeUndefined();
    expect(JSON.stringify(got.headers)).not.toContain(REAL_CREDENTIAL);
  });

  test("the egress proxy never upgrades what the box sent: a placeholder stays the placeholder", async () => {
    await viaSocket(egressSock, "http://registry.example.com/v2/", { host: "registry.example.com", authorization: "Bearer slaude-box-placeholder" });
    const got = codeHost.seen.at(-1)!;
    expect(got.headers.authorization).toBe("Bearer slaude-box-placeholder");
    expect(JSON.stringify(got.headers)).not.toContain(REAL_CREDENTIAL);
  });

  test("the egress proxy's own refusal carries no credential either", async () => {
    const r = await viaSocket(egressSock, "http://not-on-the-list.example.com/", { host: "not-on-the-list.example.com" });
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.headers) + r.body).not.toContain(REAL_CREDENTIAL);
  });

  test("the provider proxy adds the credential for the provider upstream, replacing whatever the box sent", async () => {
    const r = await viaSocket(llmSock, "/v1/messages", { host: "127.0.0.1:3129", "x-api-key": "slaude-box-placeholder" });
    expect(r.status).toBe(200);
    const got = provider.seen.at(-1)!;
    expect(got.headers["x-api-key"]).toBe(REAL_CREDENTIAL);
    // Exactly one credential header, and nothing of it comes back to the box.
    expect(CREDENTIAL_HEADERS.filter((h) => got.headers[h] !== undefined)).toEqual(["x-api-key"]);
    expect(JSON.stringify(r.headers) + r.body).not.toContain(REAL_CREDENTIAL);
  });

  test("the provider proxy has one upstream: asked for a code host, it forwards nothing and adds nothing", async () => {
    const before = { code: codeHost.seen.length, provider: provider.seen.length };
    // An absolute request target and a Host header for another site: both must be refused or ignored, never followed.
    const r = await viaSocket(llmSock, `http://127.0.0.1:${codeHost.port}/example/repo.git`, { host: "code-host.example.com", authorization: "Bearer slaude-box-placeholder" });
    expect(codeHost.seen.length).toBe(before.code);
    for (const s of codeHost.seen) expect(JSON.stringify(s.headers)).not.toContain(REAL_CREDENTIAL);
    // Either refused outright, or served by the one upstream as a path: never by the host that was asked for.
    if (provider.seen.length > before.provider) expect(provider.seen.at(-1)!.host).not.toContain("code-host.example.com");
    else expect(r.status).toBeGreaterThanOrEqual(400);
  });

  test("the credential appears in nothing the code host ever received", () => {
    expect(codeHost.seen.length).toBeGreaterThan(0);
    for (const s of codeHost.seen) expect(JSON.stringify(s)).not.toContain(REAL_CREDENTIAL);
  });
});

describe("no credential route: what can be checked before the proxies exist", () => {
  test("slaude ships no code-host MCP server and no proxy module that names a code host", () => {
    // The supported path for private code is a gateway-side MCP server the OPERATOR deploys.
    expect(existsSync(join(import.meta.dir, "../../src/box/egress/code-host.ts"))).toBe(false);
    expect(existsSync(join(import.meta.dir, "../../src/box/code-host"))).toBe(false);
  });

  test("this file skips its proxy tests only while the proxies are missing", () => {
    // The day both modules exist the suite above runs; this keeps the skip from outliving its reason.
    expect(present).toBe(existsSync(EGRESS_MODULE) && existsSync(PROVIDER_MODULE));
    if (!present) expect(WHY_SKIPPED).toContain("Phase 2");
  });
});
