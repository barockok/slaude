/**
 * The gateway is the only party that refreshes an MCP credential. Many sessions
 * on many nodes share the agent's owner and can hit one expiry together, and a
 * rotating refresh token can be spent exactly once: a second, concurrent
 * refresh would present a dead token, be refused, and wrongly tell everyone to
 * reconnect. So refresh is single-flight, and it first checks whether someone
 * else already refreshed.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { db } from "../../../src/db/schema";
import * as Creds from "../../../src/db/mcp-credentials";
import { __resetMasterKeyCache } from "../../../src/db/crypto";
import { makeCredentialRefresher, localLock } from "../../../src/gateway/core/credential-refresh";
import { RefreshRejected } from "../../../src/agent/mcp-oauth/refresh";
import type { CredentialOwner } from "../../../src/agent/credential-owner";

const KEY = "workbench|abc";
const AGENT: CredentialOwner = { kind: "agent", tenant: "t1", persona: "default" };
const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const NOW = 1_800_000_000_000;

const stored = (token: string, expiresAt: number, extra: Record<string, unknown> = {}) => ({
  serverName: "workbench",
  serverUrl: "https://mcp.example.com/mcp",
  clientId: "client-1",
  accessToken: token,
  refreshToken: `refresh-${token}`,
  expiresAt,
  ...extra,
});

function refresher(opts: { grant?: (p: any) => Promise<any>; delayMs?: number } = {}) {
  const grants: any[] = [];
  const discovered: string[] = [];
  let n = 0;
  const r = makeCredentialRefresher({
    now: () => NOW,
    lock: localLock(),
    discover: async (url) => {
      discovered.push(url);
      return { tokenEndpoint: "https://idp.example.com/token" };
    },
    grant: async (p) => {
      grants.push(p);
      if (opts.delayMs) await new Promise((res) => setTimeout(res, opts.delayMs));
      if (opts.grant) return opts.grant(p);
      n++;
      return { clientId: p.clientId, accessToken: `tok-new-${n}`, refreshToken: `refresh-new-${n}`, expiresIn: 3600 };
    },
  });
  return { r, grants, discovered };
}

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  await db.run("DELETE FROM mcp_credentials");
});

describe("refresh", () => {
  test("refreshes the token that failed and stores the new grant", async () => {
    await Creds.putCredential(AGENT, KEY, stored("tok-old", NOW + 3600_000));
    const { r, grants } = refresher();

    const out = await r.refresh(AGENT, KEY, hash("tok-old"));

    expect(out.ok && out.entry.accessToken).toBe("tok-new-1");
    expect(grants[0].refreshToken).toBe("refresh-tok-old");
    const now = (await Creds.credentialsFor(AGENT))[KEY]!;
    expect(now.accessToken).toBe("tok-new-1");
    expect(now.refreshToken).toBe("refresh-new-1");
    expect(now.expiresAt).toBe(NOW + 3600_000);
  });

  // Many sessions share the agent's owner; they must cause one provider call.
  test("concurrent refreshes for one owner and server make exactly one provider call", async () => {
    await Creds.putCredential(AGENT, KEY, stored("tok-old", NOW - 1));
    const { r, grants } = refresher({ delayMs: 30 });

    const outs = await Promise.all(Array.from({ length: 12 }, () => r.refresh(AGENT, KEY, hash("tok-old"))));

    expect(grants).toHaveLength(1);
    for (const o of outs) expect(o.ok && o.entry.accessToken).toBe("tok-new-1");
  });

  // A refresh that arrives after someone else already refreshed must not spend
  // the (now rotated) refresh token again.
  test("a token that was already replaced is returned without calling the provider", async () => {
    await Creds.putCredential(AGENT, KEY, stored("tok-already-new", NOW + 3600_000));
    const { r, grants } = refresher();

    const out = await r.refresh(AGENT, KEY, hash("tok-that-failed"));

    expect(grants).toHaveLength(0);
    expect(out.ok && out.entry.accessToken).toBe("tok-already-new");
  });

  // The server rejected this exact token before its nominal expiry (revoked
  // session, clock skew). Its expiry says fresh; the failure says otherwise.
  test("the token that failed is refreshed even if its expiry says it is fresh", async () => {
    await Creds.putCredential(AGENT, KEY, stored("tok-rejected", NOW + 3600_000));
    const { r, grants } = refresher();
    await r.refresh(AGENT, KEY, hash("tok-rejected"));
    expect(grants).toHaveLength(1);
  });

  test("a revoked grant means reconnect, and the stored entry is not deleted", async () => {
    await Creds.putCredential(AGENT, KEY, stored("tok-old", NOW - 1));
    const { r } = refresher({ grant: async () => { throw new RefreshRejected(400, "invalid_grant"); } });

    const out = await r.refresh(AGENT, KEY, hash("tok-old"));

    expect(out).toEqual({ ok: false, reason: "reconnect" });
    expect((await Creds.credentialsFor(AGENT))[KEY]!.accessToken).toBe("tok-old");
  });

  test("an entry with no refresh token means reconnect, without calling the provider", async () => {
    await Creds.putCredential(AGENT, KEY, stored("tok-old", NOW - 1, { refreshToken: undefined }));
    const { r, grants } = refresher();
    expect(await r.refresh(AGENT, KEY, hash("tok-old"))).toEqual({ ok: false, reason: "reconnect" });
    expect(grants).toHaveLength(0);
  });

  test("a server the owner never connected is reported as unknown", async () => {
    const { r } = refresher();
    expect(await r.refresh(AGENT, "never|connected", undefined)).toEqual({ ok: false, reason: "unknown-server" });
  });

  test("a transient provider failure throws, so the caller can retry later", async () => {
    await Creds.putCredential(AGENT, KEY, stored("tok-old", NOW - 1));
    const { r } = refresher({ grant: async () => { throw new Error("refresh failed at the provider (status 503)"); } });
    await expect(r.refresh(AGENT, KEY, hash("tok-old"))).rejects.toThrow();
    expect((await Creds.credentialsFor(AGENT))[KEY]!.accessToken).toBe("tok-old");
  });

  test("the grant is sent to the server's own authorization server, with its resource", async () => {
    await Creds.putCredential(AGENT, KEY, stored("tok-old", NOW - 1, { clientSecret: "shh" }));
    const { r, grants, discovered } = refresher();
    await r.refresh(AGENT, KEY, hash("tok-old"));
    expect(discovered).toEqual(["https://mcp.example.com/mcp"]);
    expect(grants[0]).toMatchObject({ tokenEndpoint: "https://idp.example.com/token", clientId: "client-1", clientSecret: "shh", resource: "https://mcp.example.com/mcp" });
  });

  test("the client secret is kept in the store across a refresh", async () => {
    await Creds.putCredential(AGENT, KEY, stored("tok-old", NOW - 1, { clientSecret: "shh" }));
    const { r } = refresher();
    await r.refresh(AGENT, KEY, hash("tok-old"));
    expect((await Creds.credentialsFor(AGENT))[KEY]!.clientSecret).toBe("shh");
  });

  test("refreshes for different owners do not wait on each other", async () => {
    const PERSONA: CredentialOwner = { kind: "agent", tenant: "t1", persona: "ana" };
    await Creds.putCredential(AGENT, KEY, stored("a-old", NOW - 1));
    await Creds.putCredential(PERSONA, KEY, stored("p-old", NOW - 1));
    const { r, grants } = refresher({ delayMs: 20 });
    await Promise.all([r.refresh(AGENT, KEY, hash("a-old")), r.refresh(PERSONA, KEY, hash("p-old"))]);
    expect(grants).toHaveLength(2);
  });
});

describe("the fast path", () => {
  test("a fresh token is returned without taking the lock", async () => {
    await Creds.putCredential(AGENT, KEY, stored("tok-fresh", NOW + 3600_000));
    let locks = 0;
    const r = makeCredentialRefresher({
      now: () => NOW,
      lock: async (_k, fn) => { locks++; return fn(); },
      discover: async () => ({ tokenEndpoint: "x" }),
      grant: async () => { throw new Error("must not be called"); },
    });
    const out = await r.refresh(AGENT, KEY, undefined);
    expect(out.ok && out.entry.accessToken).toBe("tok-fresh");
    expect(locks).toBe(0);
  });
});
