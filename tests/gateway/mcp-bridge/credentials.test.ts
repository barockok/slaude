/**
 * Which credential the bridge sends, per call (WS-C §4.2.4), with real
 * database rows (accounts, bindings, encrypted mcp_credentials) and the
 * gateway's own refresher. Each row is pinned against the EXISTING behaviour:
 * the owner the bridge uses is the one the node credential endpoint
 * (resolveOwner) serves for the same token, and a private server's mount is
 * exactly clearCredentials(cfg) plus the user's bearer, as privateOverrides
 * mounts it in mono.
 *
 *   runAs=agent                  agent's OAuth entry, else static headers
 *   runAs=user, S private        user's OAuth entry ONLY; unbound/no grant =>
 *                                "connect S", never the agent, never static
 *   runAs=user, S not private    user's OAuth entry, else static headers
 *
 * Runs on the default test database; SLAUDE_DB=pg (PGLite) runs it on Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { __resetMasterKeyCache } from "../../../src/db/crypto";
import { db } from "../../../src/db/schema";
import * as Accounts from "../../../src/db/accounts";
import * as Creds from "../../../src/db/mcp-credentials";
import { oauthKey } from "../../../src/agent/mcp-oauth/store";
import { RefreshRejected } from "../../../src/agent/mcp-oauth/refresh";
import type { CredentialOwner } from "../../../src/agent/credential-owner";
import { clearCredentials, privateOverrides } from "../../../src/gateway/core/external-mcp";
import { localLock, makeCredentialRefresher } from "../../../src/gateway/core/credential-refresh";
import { handleMcpCredentials } from "../../../src/gateway/api/mcp-credentials";
import { BridgeRefused, connectText, createMcpBridge, reauthText, type McpBridge } from "../../../src/gateway/core/mcp-bridge";
import type { JobClaims } from "../../../src/gateway/api/auth";
import { LEAKY_BODY, startUpstream } from "./upstream";

const up = startUpstream();
afterAll(() => up.stop());

const TEAM = "TTESTTEAM1";
const ISS = "https://idp.example.com";
const BOUND = "UBOUNDUSER";
const NOGRANT = "UNOGRANTUSR";
const UNBOUND = "UUNBOUNDUSR";

// The configured servers: a URL carrying a query-string secret and a static header.
const cfgUrl = `${up.url}?apikey=qs-secret`;
const SERVERS = {
  example: { type: "http", url: cfgUrl, headers: { "x-api-key": "static-key" } },
  privsvc: { type: "http", url: cfgUrl, headers: { "x-api-key": "static-key" } },
  statauth: { type: "http", url: up.url, headers: { authorization: "Bearer static-config-token" } },
} as const;
const PRIVATE = ["privsvc"];
const keyOf = (name: keyof typeof SERVERS) => oauthKey(name, SERVERS[name] as never);

const AGENT: CredentialOwner = { kind: "agent", tenant: "t1", persona: "default" };
let PERSON: CredentialOwner;

const entry = (token: string, serverUrl = up.url) => ({
  serverName: "x",
  serverUrl,
  clientId: "client-1",
  accessToken: token,
  refreshToken: `refresh-${token}`,
  expiresAt: Date.now() + 3600_000,
  tokenEndpoint: "https://idp.example.com/token",
});

const claims = (runAs: string | undefined, extra: Partial<JobClaims> = {}): JobClaims => ({
  tenant: "t1", persona: "default", session: "S1", team: TEAM, channel: "CCHAN", thread: "1.1",
  initiator: BOUND, scope: "turn", exp: 0, ...(runAs !== undefined ? { runAs } : {}), ...extra,
});

let grants: { refreshToken: string }[] = [];
let grantImpl: (p: { refreshToken: string }) => Promise<{ clientId: string; accessToken: string; refreshToken?: string; expiresIn?: number }>;
let cards: { server: string; scope: string; session: string }[] = [];
let bridge: McpBridge;

function newBridge(): McpBridge {
  return createMcpBridge({
    servers: () => ({ servers: structuredClone(SERVERS) as never, privateServices: [...PRIVATE] }),
    refresher: makeCredentialRefresher({
      lock: localLock(),
      discover: async () => ({ tokenEndpoint: "https://idp.example.com/token" }),
      grant: (async (p: { refreshToken: string }) => {
        grants.push(p);
        return grantImpl(p);
      }) as never,
    }),
    policy: { allowLoopback: true, allowedHosts: [], internalHosts: [] },
    limits: () => ({ timeoutMs: 5000, ownerConcurrency: 4, maxRequestBytes: 1 << 20, maxResultBytes: 1 << 20 }),
    onNeedsAuth: (c, server, scope) => void cards.push({ server, scope, session: c.session }),
  });
}

/** The Authorization the upstream saw on the call's own request. */
async function whoami(c: JobClaims, server = "example"): Promise<{ text: string; seen: (typeof up.seen)[number] | undefined; isError?: boolean }> {
  const before = up.seen.length;
  const r = await bridge.call(c, server, "whoami", {});
  const text = (r.content as { text: string }[])[0]!.text;
  return { text, seen: up.seen.slice(before).at(-1), isError: r.isError };
}

/** What the node credential endpoint (resolveOwner) hands out for this token. */
async function endpointToken(c: JobClaims, key: string): Promise<string | undefined> {
  const res = await handleMcpCredentials(new Request("http://gw/"), c);
  return ((await res.json()) as { entries: Record<string, { accessToken: string }> }).entries[key]?.accessToken;
}

beforeAll(() => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
});

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  await db.run("DELETE FROM mcp_credentials");
  await Accounts._wipeForTests();
  const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "a@example.com" });
  await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: BOUND, accountId: a.id, via: "signed-link" });
  const b = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-2", email: "b@example.com" });
  await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: NOGRANT, accountId: b.id, via: "signed-link" });
  PERSON = { kind: "account", accountId: a.id };
  for (const name of ["example", "privsvc"] as const) {
    await Creds.putCredential(AGENT, keyOf(name), entry("tok-agent"));
    await Creds.putCredential(PERSON, keyOf(name), entry("tok-person"));
  }
  grants = [];
  cards = [];
  up.refuse.clear();
  grantImpl = async () => ({ clientId: "client-1", accessToken: "tok-refreshed", refreshToken: "refresh-2", expiresIn: 3600 });
  await bridge?.close();
  bridge = newBridge();
});

describe("runAs = agent", () => {
  test("the agent's OAuth entry, the one the credential endpoint serves for the same token", async () => {
    const c = claims("agent");
    const r = await whoami(c);
    expect(r.text).toBe("Bearer tok-agent");
    expect(await endpointToken(c, keyOf("example"))).toBe("tok-agent");
    // Not private: the configured URL and static headers stand.
    expect(r.seen).toMatchObject({ apiKey: "static-key", search: "?apikey=qs-secret" });
  });

  test("no OAuth entry: the config's static headers", async () => {
    await db.run("DELETE FROM mcp_credentials");
    expect((await whoami(claims("agent"))).seen).toMatchObject({ auth: null, apiKey: "static-key" });
    expect((await whoami(claims("agent"), "statauth")).text).toBe("Bearer static-config-token");
  });

  test("a token without runAs (or a malformed one) is refused, never defaulted to the agent", async () => {
    for (const bad of [undefined, "user:", "root", "user:a:b"]) {
      await expect(bridge.call(claims(bad), "example", "whoami", {})).rejects.toBeInstanceOf(BridgeRefused);
    }
  });
});

describe("runAs = user, private server (privateServices)", () => {
  test("the user's OAuth entry only: the private mount's cleared URL and no static headers", async () => {
    const c = claims(`user:${BOUND}`);
    const r = await whoami(c, "privsvc");
    expect(r.text).toBe("Bearer tok-person");
    expect(await endpointToken(c, keyOf("privsvc"))).toBe("tok-person");
    // Exactly what privateOverrides mounts in mono for a locked session.
    const cleared = privateOverrides(SERVERS as never, new Set(PRIVATE), true).privsvc as { url: string; headers: object };
    expect(cleared).toEqual(clearCredentials(SERVERS.privsvc as never) as never);
    expect(r.seen).toEqual({ auth: "Bearer tok-person", apiKey: null, search: new URL(cleared.url).search });
    expect(r.seen!.search).toBe("");
  });

  test("a bound user with no grant gets 'connect S', never the agent's credential", async () => {
    const before = up.seen.length;
    const r = await bridge.call(claims(`user:${NOGRANT}`), "privsvc", "whoami", {});
    expect(r).toEqual({ content: [{ type: "text", text: connectText("privsvc") }], isError: true });
    expect(up.seen.length).toBe(before);
    expect(cards).toEqual([{ server: "privsvc", scope: "initiator", session: "S1" }]);
  });

  test("an unbound user gets 'connect S' although the agent holds a grant", async () => {
    const before = up.seen.length;
    const r = await bridge.call(claims(`user:${UNBOUND}`), "privsvc", "whoami", {});
    expect(r.content).toEqual([{ type: "text", text: connectText("privsvc") }]);
    expect(up.seen.length).toBe(before);
    // The list is refused the same way: no tools listed under the agent's identity.
    expect(await bridge.list(claims(`user:${UNBOUND}`), "privsvc")).toEqual({ tools: [], instructions: connectText("privsvc"), unavailable: true });
  });

  test("a cron-captured initiator (runAs user, no lock on the synthetic thread) gets the private rule", async () => {
    const r = await whoami(claims(`user:${BOUND}`, { lock: null, thread: "cron:job-1" }), "privsvc");
    expect(r.seen).toEqual({ auth: "Bearer tok-person", apiKey: null, search: "" });
  });

  test("the same server for an agent turn is not private: agent credential, static header, configured URL", async () => {
    const r = await whoami(claims("agent"), "privsvc");
    expect(r.seen).toEqual({ auth: "Bearer tok-agent", apiKey: "static-key", search: "?apikey=qs-secret" });
  });
});

describe("runAs = user, server not private", () => {
  test("the user's OAuth entry when present", async () => {
    const c = claims(`user:${BOUND}`);
    const r = await whoami(c);
    expect(r.seen).toEqual({ auth: "Bearer tok-person", apiKey: "static-key", search: "?apikey=qs-secret" });
    expect(await endpointToken(c, keyOf("example"))).toBe("tok-person");
  });

  test("no grant, bound or not: the static headers, never the agent's OAuth entry", async () => {
    for (const who of [NOGRANT, UNBOUND]) {
      const r = await whoami(claims(`user:${who}`));
      expect(r.seen).toEqual({ auth: null, apiKey: "static-key", search: "?apikey=qs-secret" });
    }
  });
});

describe("identity per call, sessions per owner", () => {
  test("an agent turn then a user turn in ONE session reach the upstream as different owners", async () => {
    expect((await whoami(claims("agent", { session: "S-same" }))).text).toBe("Bearer tok-agent");
    expect((await whoami(claims(`user:${BOUND}`, { session: "S-same" }))).text).toBe("Bearer tok-person");
    expect((await whoami(claims("agent", { session: "S-same" }))).text).toBe("Bearer tok-agent");
    const owners = new Set(bridge.__poolKeys().map((k) => JSON.parse(k)[0]));
    expect(owners.size).toBe(2);
  });

  test("upstream sessions are never shared across owners, even on identical static headers", async () => {
    await whoami(claims(`user:${NOGRANT}`));
    await whoami(claims(`user:${UNBOUND}`));
    await whoami(claims("agent"));
    expect(bridge.__poolKeys()).toHaveLength(3);
    // And a second call of one owner reuses its session.
    await whoami(claims("agent"));
    expect(bridge.__poolKeys()).toHaveLength(3);
  });
});

describe("refresh and re-authorisation", () => {
  test("401 => refresh once (the gateway refresher) => retry once with the new token", async () => {
    up.refuse.add("tok-agent");
    const r = await whoami(claims("agent"));
    expect(r.text).toBe("Bearer tok-refreshed");
    expect(grants).toEqual([expect.objectContaining({ refreshToken: "refresh-tok-agent" })]);
    expect((await Creds.credentialsFor(AGENT))[keyOf("example")]!.accessToken).toBe("tok-refreshed");
    expect(cards).toEqual([]);
  });

  test("a refresh the provider refuses => fixed text, the connect card once, never the upstream body", async () => {
    up.refuse.add("tok-agent");
    grantImpl = async () => {
      throw new RefreshRejected(400, "invalid_grant");
    };
    for (let i = 0; i < 2; i++) {
      const r = await bridge.call(claims("agent"), "example", "whoami", {});
      expect(r).toEqual({ content: [{ type: "text", text: reauthText("example") }], isError: true });
      expect(JSON.stringify(r)).not.toContain(LEAKY_BODY);
    }
    // Once per (session, server) per window.
    expect(cards).toEqual([{ server: "example", scope: "global", session: "S1" }]);
  });

  test("a refreshed token the server still refuses => no second refresh, fixed text", async () => {
    up.refuse.add("tok-agent");
    up.refuse.add("tok-refreshed");
    const r = await bridge.call(claims("agent"), "example", "whoami", {});
    expect(r.content).toEqual([{ type: "text", text: reauthText("example") }]);
    expect(grants).toHaveLength(1);
  });

  test("static credentials refused => fixed text and a card, no refresh attempted", async () => {
    await db.run("DELETE FROM mcp_credentials");
    up.refuse.add("static-config-token");
    const r = await bridge.call(claims("agent"), "statauth", "whoami", {});
    expect(r.content).toEqual([{ type: "text", text: reauthText("statauth") }]);
    expect(JSON.stringify(r)).not.toContain(LEAKY_BODY);
    expect(grants).toHaveLength(0);
    expect(cards).toHaveLength(1);
  });
});

describe("origin pinning", () => {
  test("a stored entry granted for another origin is never sent to this one", async () => {
    // A persona's URL moved after connect: whatever sits under the key, the
    // entry's own origin must match the configured server's.
    await Creds.putCredential(AGENT, keyOf("example"), entry("tok-old-origin", "https://old.example.com/mcp"));
    await Creds.putCredential(PERSON, keyOf("privsvc"), entry("tok-old-origin", "https://old.example.com/mcp"));
    expect((await whoami(claims("agent"))).seen).toMatchObject({ auth: null, apiKey: "static-key" });
    const r = await bridge.call(claims(`user:${BOUND}`), "privsvc", "whoami", {});
    expect(r.content).toEqual([{ type: "text", text: connectText("privsvc") }]);
    expect(up.auths).not.toContain("Bearer tok-old-origin");
  });
});
