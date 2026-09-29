/**
 * Cross-replica single-flight, over real Redis (gated on SLAUDE_REDIS_TEST_URL).
 *
 * Two refresher instances stand in for two gateway replicas: each has its own
 * in-process in-flight map, so only the Redis lock can stop them both spending
 * the same rotating refresh token.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { REAL_URL, realEnabled, testPrefix, cleanupPrefix } from "../../queue/real";
import { db } from "../../../src/db/schema";
import * as Creds from "../../../src/db/mcp-credentials";
import { __resetMasterKeyCache } from "../../../src/db/crypto";
import { makeCredentialRefresher, redisLock } from "../../../src/gateway/core/credential-refresh";
import type { CredentialOwner } from "../../../src/agent/credential-owner";

const d = describe.skipIf(!realEnabled);
const KEY = "workbench|abc";
const AGENT: CredentialOwner = { kind: "agent", tenant: "t1", persona: "default" };
const prefix = testPrefix("credrefresh");
let redis: any;

beforeAll(async () => {
  if (!realEnabled) return;
  const { Redis } = await import("ioredis");
  redis = new Redis(REAL_URL, { maxRetriesPerRequest: null });
});

afterAll(async () => {
  if (!redis) return;
  await cleanupPrefix(redis, prefix);
  await redis.quit();
});

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  await db.run("DELETE FROM mcp_credentials");
});

d("credential refresh across replicas (real Redis)", () => {
  test("two replicas refreshing the same credential make one provider call", async () => {
    await Creds.putCredential(AGENT, KEY, {
      serverName: "workbench", serverUrl: "https://mcp.example.com/mcp", clientId: "client-1",
      accessToken: "tok-old", refreshToken: "refresh-old", expiresAt: Date.now() - 1,
    });
    let grants = 0;
    const replica = () =>
      makeCredentialRefresher({
        lock: redisLock(redis, { prefix, pollMs: 10 }),
        discover: async () => ({ tokenEndpoint: "https://idp.example.com/token" }),
        grant: async (p) => {
          grants++;
          await new Promise((r) => setTimeout(r, 50));
          return { clientId: p.clientId, accessToken: `tok-new-${grants}`, refreshToken: `refresh-new-${grants}`, expiresIn: 3600 };
        },
      });
    const a = replica();
    const b = replica();
    const failed = createHash("sha256").update("tok-old").digest("hex");

    const outs = await Promise.all([
      a.refresh(AGENT, KEY, failed), b.refresh(AGENT, KEY, failed),
      a.refresh(AGENT, KEY, failed), b.refresh(AGENT, KEY, failed),
    ]);

    expect(grants).toBe(1);
    for (const o of outs) expect(o.ok && o.entry.accessToken).toBe("tok-new-1");
  });

  test("the lock is released after a refresh, so the next one proceeds", async () => {
    await Creds.putCredential(AGENT, KEY, {
      serverName: "workbench", serverUrl: "https://mcp.example.com/mcp", clientId: "client-1",
      accessToken: "tok-old", refreshToken: "refresh-old", expiresAt: Date.now() - 1,
    });
    const r = makeCredentialRefresher({
      lock: redisLock(redis, { prefix, pollMs: 10, waitMs: 500 }),
      discover: async () => ({ tokenEndpoint: "https://idp.example.com/token" }),
      grant: async (p) => { throw Object.assign(new Error("down"), { name: "Error" }); },
    });
    await r.refresh(AGENT, KEY, undefined).catch(() => {});
    const keys = await redis.keys(`${prefix}:lock:*`);
    expect(keys).toEqual([]);
  });
});
