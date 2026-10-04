/**
 * A fake Vault HTTP server for the secrets client tests: Kubernetes login,
 * token lookup-self / renew-self, and KV v2 reads, with switches for the
 * failure shapes the client must tell apart. Fake tokens and values only.
 */
import type { Server } from "bun";

export type FakeVault = {
  addr: string;
  stop(): void;
  /** secret path (`<mount>/data/<path>`) → data, or "v1" to answer in KV v1 shape, or null for a deleted version */
  secrets: Map<string, Record<string, unknown> | "v1" | null>;
  /** final paths the policy denies (403 with a valid token) */
  denied: Set<string>;
  /** tokens Vault considers live */
  live: Set<string>;
  counts: { login: number; lookup: number; renew: number; kv: number };
  /** the last login request body */
  lastLogin?: { role?: string; jwt?: string };
  /** every X-Vault-Namespace header seen, per endpoint kind */
  namespaces: Array<{ kind: string; ns: string | null }>;
  /** X-Vault-Token presented on kv reads */
  kvTokens: string[];
  /** force a status on kv reads (e.g. 503) */
  kvStatus?: number;
  /** delay every kv response by this many ms */
  kvDelayMs?: number;
  /** lease handed out by login and renew */
  leaseSeconds: number;
  /** login fails with this status when set */
  loginStatus?: number;
};

export function startFakeVault(): FakeVault {
  let n = 0;
  const fv: Omit<FakeVault, "addr" | "stop"> = {
    secrets: new Map(),
    denied: new Set(),
    live: new Set(),
    counts: { login: 0, lookup: 0, renew: 0, kv: 0 },
    namespaces: [],
    kvTokens: [],
    leaseSeconds: 3600,
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const server: Server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const token = req.headers.get("x-vault-token");
      const ns = req.headers.get("x-vault-namespace");
      if (url.pathname === "/v1/auth/kubernetes/login" && req.method === "POST") {
        fv.namespaces.push({ kind: "login", ns });
        fv.counts.login++;
        fv.lastLogin = (await req.json()) as { role?: string; jwt?: string };
        if (fv.loginStatus) return json(fv.loginStatus, { errors: ["login refused"] });
        const t = `fake-token-${++n}`;
        fv.live.add(t);
        return json(200, { auth: { client_token: t, lease_duration: fv.leaseSeconds, renewable: true } });
      }
      if (url.pathname === "/v1/auth/token/lookup-self") {
        fv.namespaces.push({ kind: "lookup", ns });
        fv.counts.lookup++;
        if (!token || !fv.live.has(token)) return json(403, { errors: ["permission denied"] });
        return json(200, { data: { ttl: fv.leaseSeconds } });
      }
      if (url.pathname === "/v1/auth/token/renew-self" && req.method === "POST") {
        fv.namespaces.push({ kind: "renew", ns });
        fv.counts.renew++;
        if (!token || !fv.live.has(token)) return json(403, { errors: ["permission denied"] });
        return json(200, { auth: { client_token: token, lease_duration: fv.leaseSeconds, renewable: true } });
      }
      if (url.pathname.startsWith("/v1/")) {
        fv.namespaces.push({ kind: "kv", ns });
        fv.counts.kv++;
        if (token) fv.kvTokens.push(token);
        if (fv.kvDelayMs) await Bun.sleep(fv.kvDelayMs);
        if (fv.kvStatus) return json(fv.kvStatus, { errors: ["forced"] });
        const path = url.pathname.slice(4);
        if (!token || !fv.live.has(token) || fv.denied.has(path)) return json(403, { errors: ["permission denied"] });
        if (!fv.secrets.has(path)) return json(404, { errors: [] });
        const s = fv.secrets.get(path);
        if (s === "v1") return json(200, { data: { api_key: "v1-shaped" }, lease_duration: 2764800 });
        if (s === null) return json(404, { data: { data: null, metadata: { deletion_time: "x", version: 2 } } });
        return json(200, { data: { data: s, metadata: { version: 1 } } });
      }
      return json(404, { errors: [] });
    },
  });
  return Object.assign(fv, {
    addr: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  }) as FakeVault;
}
