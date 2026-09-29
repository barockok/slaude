/**
 * A node seeds each session's pod-local config directory with the access
 * tokens the gateway hands it for that turn's owner.
 *
 * The file is shared with the agent's own entries (its Anthropic login lives in
 * the same .credentials.json), so seeding rewrites the mcpOAuth subtree and
 * nothing else. And it replaces that subtree wholesale: a previous owner's
 * tokens must never survive into a turn that runs as someone else.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedCredentials, snapshotCredentials } from "../../src/node/credentials";
import { NodeClient } from "../../src/node/client";
import { JOB_HEADER } from "../../src/gateway/api/auth";

const KEY = "workbench|abc";
const cred = (token: string) => ({
  serverName: "workbench",
  serverUrl: "https://mcp.example.com",
  clientId: "client-1",
  accessToken: token,
  expiresAt: Date.now() + 3600_000,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seed-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = () => join(dir, ".credentials.json");
const raw = () => JSON.parse(readFileSync(file(), "utf8"));

describe("seedCredentials", () => {
  test("writes the entries under mcpOAuth at 0600", async () => {
    await seedCredentials(dir, { [KEY]: cred("tok-1") });
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(raw().mcpOAuth[KEY].accessToken).toBe("tok-1");
  });

  test("preserves everything outside mcpOAuth", async () => {
    writeFileSync(file(), JSON.stringify({ claudeAiOauth: { accessToken: "agent-own" } }), { mode: 0o600 });
    await seedCredentials(dir, { [KEY]: cred("tok-1") });
    expect(raw().claudeAiOauth.accessToken).toBe("agent-own");
    expect(raw().mcpOAuth[KEY].accessToken).toBe("tok-1");
  });

  // A turn that runs as someone else must not inherit the last owner's tokens.
  test("replaces mcpOAuth wholesale, so nothing from an earlier owner survives", async () => {
    await seedCredentials(dir, { [KEY]: cred("tok-agent"), "other|x": cred("tok-other") });
    await seedCredentials(dir, { [KEY]: cred("tok-person") });
    expect(Object.keys(raw().mcpOAuth)).toEqual([KEY]);
    expect(JSON.stringify(raw())).not.toContain("tok-agent");
  });

  test("an empty set leaves no tokens behind", async () => {
    await seedCredentials(dir, { [KEY]: cred("tok-1") });
    await seedCredentials(dir, {});
    expect(raw().mcpOAuth).toEqual({});
  });

  test("a corrupt existing file is replaced rather than crashing the session boot", async () => {
    writeFileSync(file(), "{not json", { mode: 0o600 });
    await seedCredentials(dir, { [KEY]: cred("tok-1") });
    expect(raw().mcpOAuth[KEY].accessToken).toBe("tok-1");
  });

  // Only what the gateway sent is written. A field the projection never
  // carries cannot appear by accident.
  test("writes only the fields it was given", async () => {
    await seedCredentials(dir, { [KEY]: cred("tok-1") });
    expect(Object.keys(raw().mcpOAuth[KEY]).sort()).toEqual(["accessToken", "clientId", "expiresAt", "serverName", "serverUrl"]);
  });

  // The pod-local file must hold its tokens itself. Following a link would
  // write them wherever the link points — the shared volume, for instance.
  test("a symlink at the credentials path is replaced, never written through", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "elsewhere-"));
    const target = join(elsewhere, "shared.json");
    writeFileSync(target, JSON.stringify({ claudeAiOauth: { accessToken: "foreign" } }));
    symlinkSync(target, file());

    await seedCredentials(dir, { [KEY]: cred("tok-1") });

    expect(lstatSync(file()).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, "utf8")).not.toContain("tok-1");
    expect(JSON.stringify(raw())).not.toContain("foreign");
    rmSync(elsewhere, { recursive: true, force: true });
  });

  test("leaves no temp files behind", async () => {
    await seedCredentials(dir, { [KEY]: cred("tok-1") });
    await seedCredentials(dir, { [KEY]: cred("tok-2") });
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });
});

describe("snapshotCredentials", () => {
  test("reads back the mcpOAuth subtree", async () => {
    await seedCredentials(dir, { [KEY]: cred("tok-1") });
    expect(snapshotCredentials(dir)[KEY]!.accessToken).toBe("tok-1");
  });

  test("is empty when there is no file", () => {
    expect(snapshotCredentials(dir)).toEqual({});
  });
});

describe("NodeClient.getMcpCredentials", () => {
  let server: ReturnType<typeof Bun.serve>;
  const seen: Array<{ path: string; job: string | null; inm: string | null }> = [];
  let version = 1;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        seen.push({ path: url.pathname, job: req.headers.get(JOB_HEADER), inm: req.headers.get("if-none-match") });
        if (url.pathname === "/v1/tenants/t1/mcp-credentials") {
          return Response.json({ entries: { [KEY]: cred(`tok-v${version}`) } }, { headers: { etag: `"v${version}"` } });
        }
        return new Response("{}", { status: 404 });
      },
    });
  });
  afterAll(() => server.stop(true));

  const client = () => new NodeClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: "node-bearer" });

  test("fetches the tenant's endpoint with the job token", async () => {
    seen.length = 0;
    const got = await client().getMcpCredentials("t1", "job-token-1");
    expect(got[KEY]!.accessToken).toBe("tok-v1");
    expect(seen[0]).toMatchObject({ path: "/v1/tenants/t1/mcp-credentials", job: "job-token-1" });
  });

  // A credential that changed is exactly what must not be served from cache.
  test("never caches: a changed credential is seen on the very next call", async () => {
    const c = client();
    version = 1;
    expect((await c.getMcpCredentials("t1", "j"))[KEY]!.accessToken).toBe("tok-v1");
    version = 2;
    seen.length = 0;
    expect((await c.getMcpCredentials("t1", "j"))[KEY]!.accessToken).toBe("tok-v2");
    expect(seen[0]!.inm).toBeNull();
  });

  test("the tenant is path-encoded", async () => {
    seen.length = 0;
    await client().getMcpCredentials("t/../x", "j").catch(() => {});
    expect(seen[0]!.path).toBe("/v1/tenants/t%2F..%2Fx/mcp-credentials");
  });
});

describe("makeSessionSeeder", () => {
  const { makeSessionSeeder } = require("../../src/node/credentials") as typeof import("../../src/node/credentials");

  function seeder(fetchImpl: (tenant: string, token: string) => Promise<Record<string, any>>) {
    const calls: Array<[string, string]> = [];
    const logs: string[] = [];
    const s = makeSessionSeeder({
      fetch: async (tenant, token) => {
        calls.push([tenant, token]);
        return fetchImpl(tenant, token);
      },
      tenantFor: (id) => (id === "s1" ? "t1" : undefined),
      tokenFor: (id) => (id === "s1" ? "job-1" : undefined),
      log: (m) => logs.push(m),
    });
    return { s, calls, logs };
  }

  test("at boot, seeds what the gateway returns for the session's tenant and token", async () => {
    const { s, calls } = seeder(async () => ({ [KEY]: cred("tok-1") }));
    await s.atBoot("s1", dir);
    expect(calls).toEqual([["t1", "job-1"]]);
    expect(snapshotCredentials(dir)[KEY]!.accessToken).toBe("tok-1");
  });

  // Booting with stale tokens from some earlier owner would be worse than
  // booting with none: the failure then surfaces as a connect prompt.
  test("at boot, a failed fetch seeds nothing rather than leaving old tokens", async () => {
    await seedCredentials(dir, { [KEY]: cred("stale") });
    const { s } = seeder(async () => { throw new Error("gateway down"); });
    await s.atBoot("s1", dir);
    expect(snapshotCredentials(dir)).toEqual({});
  });

  test("at turn start, a failed fetch keeps the current tokens, since the owner has not changed", async () => {
    await seedCredentials(dir, { [KEY]: cred("current") });
    const { s } = seeder(async () => { throw new Error("gateway down"); });
    await s.atTurn("s1", dir);
    expect(snapshotCredentials(dir)[KEY]!.accessToken).toBe("current");
  });

  test("at turn start, fresh tokens replace the file", async () => {
    await seedCredentials(dir, { [KEY]: cred("old") });
    const { s } = seeder(async () => ({ [KEY]: cred("new") }));
    await s.atTurn("s1", dir);
    expect(snapshotCredentials(dir)[KEY]!.accessToken).toBe("new");
  });

  test("a session with no bound tenant or token is not fetched for, and boots empty", async () => {
    const { s, calls } = seeder(async () => ({ [KEY]: cred("x") }));
    await s.atBoot("unknown", dir);
    expect(calls).toEqual([]);
    expect(snapshotCredentials(dir)).toEqual({});
  });

  test("a failure is logged without any token", async () => {
    const { s, logs } = seeder(async () => { throw new Error("refused tok-secret-in-error"); });
    await s.atBoot("s1", dir);
    expect(logs.join("\n")).toContain("s1");
    expect(logs.join("\n")).not.toContain("tok-secret");
  });
});
