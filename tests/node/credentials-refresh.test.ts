/**
 * Branch R (Task 1 field note): when an MCP call fails, the node asks the SDK
 * which servers are needs-auth — a structured status, not an error string —
 * has the gateway refresh each one it holds a credential for, rewrites the
 * pod-local file, and reconnects the server.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAuthRecovery, seedCredentials, snapshotCredentials } from "../../src/node/credentials";

const KEY = "workbench|abc";
const cred = (token: string, serverName = "workbench") => ({
  serverName,
  serverUrl: "https://mcp.example.com/mcp",
  clientId: "client-1",
  accessToken: token,
  expiresAt: Date.now() + 3600_000,
});
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "recover-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function harness(opts: {
  statuses?: Array<{ name: string; status: string }>;
  refresh?: (serverKey: string, failedHash: string) => Promise<any>;
  delayMs?: number;
} = {}) {
  const refreshes: Array<{ tenant: string; token: string; serverKey: string; failedHash: string }> = [];
  const reconnects: string[] = [];
  const logs: string[] = [];
  let statuses = opts.statuses ?? [{ name: "workbench", status: "needs-auth" }];
  const r = makeAuthRecovery({
    status: async () => statuses,
    reconnect: async (_sid, server) => {
      reconnects.push(server);
    },
    refresh: async (tenant, token, serverKey, failedHash) => {
      refreshes.push({ tenant, token, serverKey, failedHash });
      if (opts.delayMs) await new Promise((res) => setTimeout(res, opts.delayMs));
      return opts.refresh ? opts.refresh(serverKey, failedHash) : cred("tok-new");
    },
    dirFor: () => dir,
    tenantFor: () => "t1",
    tokenFor: () => "job-1",
    log: (m) => logs.push(m),
  });
  return { r, refreshes, reconnects, logs, setStatuses: (s: typeof statuses) => (statuses = s) };
}

describe("makeAuthRecovery", () => {
  test("a needs-auth server is refreshed through the gateway, rewritten, and reconnected", async () => {
    await seedCredentials(dir, { [KEY]: cred("tok-old") });
    const h = harness();

    await h.r.onToolError("s1");

    expect(h.refreshes).toEqual([{ tenant: "t1", token: "job-1", serverKey: KEY, failedHash: hash("tok-old") }]);
    expect(snapshotCredentials(dir)[KEY]!.accessToken).toBe("tok-new");
    expect(h.reconnects).toEqual(["workbench"]);
  });

  // The node proves which token failed without ever sending it.
  test("the gateway receives a hash of the failed token, never the token", async () => {
    await seedCredentials(dir, { [KEY]: cred("tok-old") });
    const h = harness();
    await h.r.onToolError("s1");
    expect(JSON.stringify(h.refreshes)).not.toContain("tok-old");
  });

  test("a tool error with every server connected does nothing", async () => {
    await seedCredentials(dir, { [KEY]: cred("tok-old") });
    const h = harness({ statuses: [{ name: "workbench", status: "connected" }] });
    await h.r.onToolError("s1");
    expect(h.refreshes).toEqual([]);
  });

  test("a needs-auth server this session holds no credential for is left alone", async () => {
    await seedCredentials(dir, { [KEY]: cred("tok-old") });
    const h = harness({ statuses: [{ name: "somebody-elses", status: "needs-auth" }] });
    await h.r.onToolError("s1");
    expect(h.refreshes).toEqual([]);
  });

  test("several failures for one server at once cause one refresh", async () => {
    await seedCredentials(dir, { [KEY]: cred("tok-old") });
    const h = harness({ delayMs: 20 });
    await Promise.all([h.r.onToolError("s1"), h.r.onToolError("s1"), h.r.onToolError("s1")]);
    expect(h.refreshes).toHaveLength(1);
  });

  // The owner must reconnect. Refreshing again cannot help, and looping would
  // hit the gateway on every failed call.
  test("reconnect means stop: no rewrite, no reconnect, and no retry this turn", async () => {
    await seedCredentials(dir, { [KEY]: cred("tok-old") });
    const h = harness({ refresh: async () => "reconnect" });
    await h.r.onToolError("s1");
    await h.r.onToolError("s1");
    expect(h.refreshes).toHaveLength(1);
    expect(h.reconnects).toEqual([]);
    expect(snapshotCredentials(dir)[KEY]!.accessToken).toBe("tok-old");
  });

  test("a server that keeps failing is refreshed at most twice per turn", async () => {
    await seedCredentials(dir, { [KEY]: cred("tok-old") });
    let n = 0;
    const h = harness({ refresh: async () => cred(`tok-${++n}`) });
    for (let i = 0; i < 5; i++) await h.r.onToolError("s1");
    expect(h.refreshes).toHaveLength(2);
  });

  test("a new turn lifts the per-turn limit", async () => {
    await seedCredentials(dir, { [KEY]: cred("tok-old") });
    let n = 0;
    const h = harness({ refresh: async () => cred(`tok-${++n}`) });
    for (let i = 0; i < 3; i++) await h.r.onToolError("s1");
    h.r.resetTurn("s1");
    await h.r.onToolError("s1");
    expect(h.refreshes).toHaveLength(3);
  });

  test("a transient gateway failure is logged without a token and leaves the file", async () => {
    await seedCredentials(dir, { [KEY]: cred("tok-old") });
    const h = harness({ refresh: async () => { throw Object.assign(new Error("tok-old in a body"), { status: 503 }); } });
    await h.r.onToolError("s1");
    expect(snapshotCredentials(dir)[KEY]!.accessToken).toBe("tok-old");
    expect(h.logs.join("\n")).not.toContain("tok-old");
    expect(h.logs.join("\n")).toContain("status=503");
  });

  test("only the refreshed server's entry changes", async () => {
    await seedCredentials(dir, { [KEY]: cred("tok-old"), "gh|x": cred("tok-gh", "github") });
    const h = harness();
    await h.r.onToolError("s1");
    expect(snapshotCredentials(dir)["gh|x"]!.accessToken).toBe("tok-gh");
  });

  test("a session not live on this node is ignored", async () => {
    const h = harness();
    const r2 = makeAuthRecovery({
      status: async () => null,
      reconnect: async () => {},
      refresh: async () => cred("x"),
      dirFor: () => dir,
      tenantFor: () => "t1",
      tokenFor: () => "job-1",
    });
    await r2.onToolError("s1");
    expect(h.refreshes).toEqual([]);
  });
});

describe("NodeClient.refreshMcpCredential", () => {
  const { NodeClient } = require("../../src/node/client") as typeof import("../../src/node/client");
  let answer: () => Response = () => Response.json({ entry: cred("tok-new") });
  const bodies: any[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      bodies.push({ path: new URL(req.url).pathname, body: await req.json().catch(() => null) });
      return answer();
    },
  });
  const client = () => new NodeClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: "b", baseDelayMs: 1 });

  test("posts the server key and the failed token's hash to the tenant's refresh route", async () => {
    bodies.length = 0;
    const out = await client().refreshMcpCredential("t1", "job", KEY, hash("tok-old"));
    expect(out).toMatchObject({ accessToken: "tok-new" });
    expect(bodies[0]).toEqual({ path: "/v1/tenants/t1/mcp-credentials/refresh", body: { serverKey: KEY, failedAccessTokenHash: hash("tok-old") } });
  });

  test("409 means reconnect and 404 means no such credential", async () => {
    answer = () => Response.json({ reconnect: true }, { status: 409 });
    expect(await client().refreshMcpCredential("t1", "job", KEY, hash("x"))).toBe("reconnect");
    answer = () => Response.json({ error: "no such credential" }, { status: 404 });
    expect(await client().refreshMcpCredential("t1", "job", KEY, hash("x"))).toBeNull();
    answer = () => Response.json({ entry: cred("tok-new") });
  });
});
