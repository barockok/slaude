/**
 * The session pool under failure (review round on U12):
 *   - a call interrupted on a session the upstream forgot retires that
 *     session, so later calls do not keep failing until idle expiry;
 *   - a shared session open has its own timeout, not its first opener's
 *     remaining budget;
 *   - a caller waiting on a shared open honours its own abort;
 *   - a closed, retired or idle-expired session is ended upstream (DELETE),
 *     best effort and never in the way of a call.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cancelledText, createMcpBridge, interruptedText, timeoutText, type BridgeLimits } from "../../../src/gateway/core/mcp-bridge";
import type { JobClaims } from "../../../src/gateway/api/auth";
import { startUpstream, type Upstream } from "./upstream";

const claims: JobClaims = {
  tenant: "t1", persona: "default", session: "S1", team: "TTEAM", channel: "CCHAN", thread: "1.1",
  initiator: "UUSER1", scope: "turn", runAs: "agent", exp: 0,
};
const LIMITS: BridgeLimits = { timeoutMs: 5000, ownerConcurrency: 4, maxRequestBytes: 1 << 20, maxResultBytes: 1 << 20 };
const ups: Upstream[] = [];
afterAll(() => {
  for (const u of ups) u.stop();
});
const upstream = (o: Parameters<typeof startUpstream>[0] = {}) => {
  const u = startUpstream(o);
  ups.push(u);
  return u;
};
const bridgeAt = (url: string, limits: Partial<BridgeLimits> = {}, now?: () => number) =>
  createMcpBridge({
    ...(now ? { now } : {}),
    servers: () => ({ servers: { s: { type: "http", url } as never }, privateServices: [] }),
    accountFor: async () => null,
    credentialsFor: async () => ({}),
    policy: { allowLoopback: true, allowedHosts: [], internalHosts: [] },
    limits: () => ({ ...LIMITS, ...limits }),
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(10);
  }
};
const count = (up: Upstream, m: string) => up.methods.filter((x) => x === m).length;
const deletes = (up: Upstream) => up.verbs.filter((v) => v === "DELETE").length;
const text = (t: string) => [{ type: "text", text: t }];

describe("an interrupted call retires its session", () => {
  test("an upstream answering 500 for a forgotten session: one call is interrupted, the next opens a fresh session", async () => {
    const up = upstream({ unknownSessionStatus: 500 });
    const b = bridgeAt(up.url);
    try {
      await b.call(claims, "s", "echo", { text: "warm" });
      up.restart();
      expect(await b.call(claims, "s", "echo", { text: "lost" })).toEqual({ content: text(interruptedText("s")), isError: true });
      expect((await b.call(claims, "s", "echo", { text: "next" })).content).toEqual(text("next"));
      // At most once: the interrupted call was not repeated.
      expect(count(up, "tools/call")).toBe(3);
      expect(count(up, "initialize")).toBe(2);
    } finally {
      await b.close();
    }
  });
});
