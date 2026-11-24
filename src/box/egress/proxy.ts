/**
 * A box's egress proxy (box spec, "Credential and egress model").
 *
 * One HTTP proxy per session, listening on a Unix socket in the session's run
 * directory, which the supervisor bind mounts into the sandbox. A box has no
 * network: this socket is its only way to a host that is not the model
 * provider. Because the listener belongs to one session, every request is
 * attributed without trusting anything the box says.
 *
 * For each connection:
 *
 *   1. read one request head (CONNECT, or plain HTTP in absolute form);
 *   2. ask the rules, read fresh from the supplier, so an allowlist change
 *      reaches a running session at its next connection;
 *   3. refuse the node's own services (the gateway, Redis, the object store)
 *      whatever the rules say;
 *   4. resolve the name ONCE, refuse when any answer is a loopback, private,
 *      link-local, metadata or reserved address, and connect to an address
 *      that was checked (no second resolution, so no rebinding window);
 *   5. pipe bytes. Nothing is added: no header, no credential. What the box
 *      sent is what the upstream receives, minus the two proxy hop headers.
 *
 * A refusal is a 403 with one plain sentence. This proxy holds no credential
 * and never sees one: with no TLS inspection it knows the CONNECT host only.
 */
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { Socket, createServer, isIP, type Server } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { dirname } from "node:path";
import { classifyAddress, type ResolvedAddress, type Resolver } from "../../net/outbound-policy";
import type { BoxEgress } from "../policy";
import { egressRefusalText, egressVerdict, normalizeHost } from "./policy";

export type EgressRefusal = "not-allowlisted" | "denied" | "invalid-host" | "node-service" | "private-address" | "unresolved" | "bad-request" | "unreachable";

export interface EgressProxyOpts {
  socketPath: string;
  /** The session's rules, read on every connection. A throw refuses the connection. */
  rules: () => BoxEgress | Promise<BoxEgress>;
  /** Host names that are always refused: the gateway, Redis and the object store endpoint. */
  refuseHosts?: readonly string[];
  /** Default: the system resolver. */
  resolver?: Resolver;
  /**
   * TEST SEAM: where an allowed `host:port` is dialed. When given, it replaces
   * the resolution and the address check (a test stands a local server in for
   * a public host). Production never sets it.
   */
  dial?: (host: string, port: number) => { host: string; port: number } | Promise<{ host: string; port: number }>;
  /** Called for every refusal, with the host and never the path. */
  onRefuse?: (e: { host: string; port: number; reason: EgressRefusal }) => void;
  /** Called for every connection that was allowed and opened. */
  onAllow?: (e: { host: string; port: number }) => void;
  /** Mode of the socket file. Default 0666: the sandbox's user is not the node's. */
  socketMode?: number;
  connectTimeoutMs?: number;
  headTimeoutMs?: number;
}

export interface EgressProxy {
  socketPath: string;
  /** End every open connection whose host the current rules refuse. Returns how many were ended. */
  closeDisallowed(): Promise<number>;
  /** Open connections, by `host:port`. */
  open(): string[];
  close(): Promise<void>;
}

const MAX_HEAD_BYTES = 64 * 1024;
const HOP_HEADERS = new Set(["proxy-connection", "proxy-authorization", "proxy-authenticate"]);

const systemResolver: Resolver = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family }));

function refusalResponse(status: number, statusText: string, body: string): string {
  const text = `${body}\n`;
  return `HTTP/1.1 ${status} ${statusText}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\nX-Slaude-Egress: refused\r\n\r\n${text}`;
}

/** `host:port` of a CONNECT target or of an absolute http URL. Null when it is neither. */
export function parseTarget(method: string, target: string): { host: string; port: number; path: string | null } | null {
  if (method === "CONNECT") {
    const m = /^(\[[0-9a-fA-F:.]+\]|[^:\s/]+):(\d{1,5})$/.exec(target);
    if (!m) return null;
    return { host: normalizeHost(m[1]!), port: Number(m[2]), path: null };
  }
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  // https in absolute form would have this proxy speak TLS for the box: not a thing it does.
  if (url.protocol !== "http:" || url.username || url.password) return null;
  return { host: normalizeHost(url.hostname), port: url.port ? Number(url.port) : 80, path: `${url.pathname}${url.search}` };
}

interface Tunnel {
  host: string;
  port: number;
  client: Socket;
  upstream: Socket;
}

export async function startEgressProxy(opts: EgressProxyOpts): Promise<EgressProxy> {
  const resolver = opts.resolver ?? systemResolver;
  const refuseHosts = new Set((opts.refuseHosts ?? []).map(normalizeHost).filter(Boolean));
  const tunnels = new Set<Tunnel>();
  const sockets = new Set<Socket>();

  const refuse = (client: Socket, host: string, port: number, reason: EgressRefusal): void => {
    try {
      opts.onRefuse?.({ host, port, reason });
    } catch {
      /* a reporting failure never changes the answer */
    }
    const body =
      reason === "bad-request"
        ? "egress refused: this proxy accepts CONNECT and plain http requests only."
        : reason === "unreachable"
          ? `egress failed: ${host || "the host"} could not be reached.`
          : reason === "unresolved"
            ? `egress failed: ${host || "the host"} could not be resolved.`
            : egressRefusalText(host);
    const status = reason === "bad-request" ? [400, "Bad Request"] : reason === "unreachable" || reason === "unresolved" ? [502, "Bad Gateway"] : [403, "Forbidden"];
    client.end(refusalResponse(status[0] as number, status[1] as string, body));
  };

  /** The address to connect to, or a refusal. Resolves once; every answer is checked. */
  async function destination(host: string, port: number): Promise<{ host: string; port: number } | EgressRefusal> {
    if (opts.dial) return opts.dial(host, port);
    let addresses: ResolvedAddress[];
    const family = isIP(host);
    if (family) addresses = [{ address: host, family }];
    else {
      try {
        addresses = await resolver(host);
      } catch {
        addresses = [];
      }
      if (!addresses.length) return "unresolved";
    }
    // One private answer among public ones refuses the name: a mixed answer is how a rebinding attempt looks.
    for (const a of addresses) if (classifyAddress(a.address) !== null) return "private-address";
    return { host: addresses[0]!.address, port };
  }

  async function handle(client: Socket, head: Buffer, rest: Buffer): Promise<void> {
    const lines = head.toString("latin1").split("\r\n");
    const [method = "", target = "", version = ""] = (lines[0] ?? "").split(" ");
    const parsed = /^HTTP\/1\.[01]$/.test(version) ? parseTarget(method.toUpperCase(), target) : null;
    if (!parsed) return refuse(client, "", 0, "bad-request");
    const { host, port, path } = parsed;

    if (refuseHosts.has(host)) return refuse(client, host, port, "node-service");
    let rules: BoxEgress;
    try {
      rules = await opts.rules();
    } catch {
      // Rules that cannot be read are not "allow": the connection is refused.
      return refuse(client, host, port, "not-allowlisted");
    }
    const verdict = egressVerdict(rules, host, port);
    if (!verdict.allow) return refuse(client, host, port, verdict.reason);
    const dest = await destination(host, port);
    if (typeof dest === "string") return refuse(client, host, port, dest);
    if (client.destroyed) return;

    // Connected last, after its listeners are on: an error event with no listener would take the worker down.
    const upstream = new Socket();
    const tunnel: Tunnel = { host, port, client, upstream };
    const timer = setTimeout(() => upstream.destroy(new Error("connect timeout")), opts.connectTimeoutMs ?? 15_000);
    let opened = false;
    const done = () => {
      clearTimeout(timer);
      tunnels.delete(tunnel);
      upstream.destroy();
      client.destroy();
    };
    upstream.once("connect", () => {
      clearTimeout(timer);
      opened = true;
      tunnels.add(tunnel);
      try {
        opts.onAllow?.({ host, port });
      } catch {
        /* reporting only */
      }
      if (path === null) {
        client.write("HTTP/1.1 200 Connection established\r\n\r\n");
      } else {
        // Plain HTTP: the request goes on in origin form. Nothing is added; only the proxy's own hop headers are dropped.
        const headers = lines.slice(1).filter((l) => l && !HOP_HEADERS.has(l.slice(0, l.indexOf(":")).trim().toLowerCase()) && !/^connection\s*:/i.test(l));
        upstream.write(Buffer.from(`${method} ${path || "/"} ${version}\r\n${headers.join("\r\n")}\r\nConnection: close\r\n\r\n`, "latin1"));
      }
      if (rest.length) upstream.write(rest);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
    upstream.once("error", () => {
      if (!opened && !client.destroyed) refuse(client, host, port, "unreachable");
      done();
    });
    upstream.once("close", done);
    client.once("close", done);
    upstream.on("error", () => {});
    upstream.connect({ host: dest.host, port: dest.port });
  }

  const server: Server = createServer((client) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    client.on("error", () => {});
    let buf: Buffer = Buffer.alloc(0);
    const headTimer = setTimeout(() => client.destroy(), opts.headTimeoutMs ?? 15_000);
    const onData = (d: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buf.length > MAX_HEAD_BYTES) {
          clearTimeout(headTimer);
          client.off("data", onData);
          refuse(client, "", 0, "bad-request");
        }
        return;
      }
      clearTimeout(headTimer);
      client.off("data", onData);
      client.pause();
      void handle(client, buf.subarray(0, end), buf.subarray(end + 4)).catch(() => client.destroy());
    };
    client.on("data", onData);
  });

  mkdirSync(dirname(opts.socketPath), { recursive: true });
  if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(opts.socketPath, opts.socketMode ?? 0o666);

  return {
    socketPath: opts.socketPath,
    open: () => [...tunnels].map((t) => `${t.host}:${t.port}`),
    async closeDisallowed() {
      let rules: BoxEgress;
      try {
        rules = await opts.rules();
      } catch {
        rules = { allow: [], deny: [] };
      }
      let n = 0;
      for (const t of [...tunnels]) {
        if (!refuseHosts.has(t.host) && egressVerdict(rules, t.host, t.port).allow) continue;
        n++;
        tunnels.delete(t);
        t.upstream.destroy();
        t.client.destroy();
      }
      return n;
    },
    async close() {
      for (const s of sockets) s.destroy();
      for (const t of tunnels) t.upstream.destroy();
      tunnels.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        unlinkSync(opts.socketPath);
      } catch {
        /* already gone */
      }
    },
  };
}
