/**
 * Static (config-supplied) headers are a credential bound to the host they
 * were first sent to (review M1c): a server whose URL moves to another origin
 * with the same headers is refused with fixed text, and the new host sees
 * nothing. A config may not set transport or session headers (review m2).
 * The pins are shared across gateway replicas through Redis.
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  createMcpBridge,
  localOriginPins,
  pinnedElsewhereText,
  redisOriginPins,
  type OriginPins,
} from "../../../src/gateway/core/mcp-bridge";
import type { JobClaims } from "../../../src/gateway/api/auth";
import { createRedis } from "../../../src/queue/redis";
import { startUpstream } from "./upstream";

const a = startUpstream();
const b = startUpstream();
afterAll(() => {
  a.stop();
  b.stop();
});

const claims: JobClaims = {
  tenant: "t1", persona: "ana", session: "S1", team: "TTEAM", channel: "CCHAN", thread: "1.1",
  initiator: "UUSER1", scope: "turn", runAs: "agent", exp: 0,
};

function bridgeWith(cfg: { url: string; headers?: Record<string, string> }, pins: OriginPins) {
  return createMcpBridge({
    servers: () => ({ servers: { s: { type: "http", ...cfg } as never }, privateServices: [] }),
    accountFor: async () => null,
    credentialsFor: async () => ({}),
    policy: { allowLoopback: true, allowedHosts: [], internalHosts: [] },
    limits: () => ({ timeoutMs: 5000, ownerConcurrency: 4, maxRequestBytes: 1 << 20, maxResultBytes: 1 << 20 }),
    originPins: pins,
  });
}

async function whoami(cfg: { url: string; headers?: Record<string, string> }, pins: OriginPins) {
  const br = bridgeWith(cfg, pins);
  try {
    return await br.call(claims, "s", "whoami", {});
  } finally {
    await br.close();
  }
}

describe("static credentials are pinned to their first origin", () => {
  test("a moved URL with the same headers is refused and the new host sees nothing", async () => {
    const pins = localOriginPins();
    const headers = { authorization: "Bearer static-secret" };
    expect((await whoami({ url: a.url, headers }, pins)).content).toEqual([{ type: "text", text: "Bearer static-secret" }]);
    const seenB = b.paths.length;
    expect(await whoami({ url: b.url, headers }, pins)).toEqual({ content: [{ type: "text", text: pinnedElsewhereText("s") }], isError: true });
    expect(b.paths.length).toBe(seenB);
    // The list is refused the same way.
    const br = bridgeWith({ url: b.url, headers }, pins);
    expect(await br.list(claims, "s")).toEqual({ tools: [], instructions: pinnedElsewhereText("s"), unavailable: true });
    await br.close();
    // Rotated headers are a new credential: allowed at the new origin.
    expect((await whoami({ url: b.url, headers: { authorization: "Bearer rotated" } }, pins)).content).toEqual([{ type: "text", text: "Bearer rotated" }]);
    // A server with no config headers carries nothing to pin.
    expect((await whoami({ url: b.url }, pins)).isError).toBeUndefined();
  });

  test("a config cannot set transport or session headers", async () => {
    const before = a.seen.length;
    const r = await whoami(
      {
        url: a.url,
        headers: { host: "evil.example.com", "mcp-session-id": "forged", "content-length": "1", connection: "close", "x-api-key": "kept" },
      },
      localOriginPins(),
    );
    expect(r.isError).toBeUndefined();
    expect(a.seen.slice(before).every((s) => s.apiKey === "kept")).toBe(true);
  });

  test.skipIf(!process.env.SLAUDE_REDIS_TEST_URL)("pins are shared across replicas (Redis)", async () => {
    const redis = createRedis(process.env.SLAUDE_REDIS_TEST_URL!);
    const prefix = `u12-pin-${randomBytes(4).toString("hex")}`;
    try {
      const headers = { authorization: "Bearer shared-static" };
      expect((await whoami({ url: a.url, headers }, redisOriginPins(redis, prefix))).isError).toBeUndefined();
      // Another replica (another pin client) refuses the moved URL, and logs
      // the pin id (a hash, never a secret) once.
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      let logged: string[] = [];
      try {
        expect((await whoami({ url: b.url, headers }, redisOriginPins(redis, prefix))).content).toEqual([{ type: "text", text: pinnedElsewhereText("s") }]);
        logged = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("pin id="));
      } finally {
        warn.mockRestore();
      }
      expect(logged).toHaveLength(1);
      expect(logged[0]).not.toContain("shared-static");
      const id = logged[0]!.split("pin id=")[1]!;
      // The documented remedy: delete that key, and the move is accepted.
      expect(await redis.del(`${prefix}:mcpx-origin-pin:${id}`)).toBe(1);
      expect((await whoami({ url: b.url, headers }, redisOriginPins(redis, prefix))).isError).toBeUndefined();
    } finally {
      const keys = await redis.keys(`${prefix}:*`);
      if (keys.length) await redis.del(...keys);
      redis.disconnect();
    }
  });
});
