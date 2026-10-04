/**
 * Memory sits on a turn's boot path, so a hung gateway must not stall it:
 * every memory call is one bounded attempt (NodeClient.memoryTimeoutMs, body
 * included, no retry), and the node's provider turns a timeout into "no
 * memory", logged once per kind and counted.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { NodeClient, MemoryTimeoutError } from "../../src/node/client";
import { makeNodeMemoryProvider, MEMORY_TURN_MAX_CHARS } from "../../src/node/memory";
import { metrics } from "../../src/metrics";

const BOUND = 150;

const counter = (kind: string) => {
  const line = metrics.render().split("\n").find((l) => l.startsWith("slaude_memory_gateway_failures_total") && l.includes(`kind="${kind}"`));
  return line ? Number(line.split(" ").pop()) : 0;
};

describe("memory calls are bounded", () => {
  test("a fetch that never resolves (and ignores the abort): prefetch gives up within the bound, logged once", async () => {
    const client = new NodeClient({ baseUrl: "http://gw", token: "t", memoryTimeoutMs: BOUND, fetchImpl: (() => new Promise(() => {})) as any });
    await expect(client.memoryPrefetch("tok")).rejects.toBeInstanceOf(MemoryTimeoutError);
    const warnings: string[] = [];
    const before = counter("prefetch:timeout");
    const p = makeNodeMemoryProvider({ client, tokenFor: () => "tok", warn: (m) => warnings.push(m) });
    const t0 = Date.now();
    expect(await p.prefetch("s1")).toBeNull();
    expect(await p.prefetch("s1")).toBeNull();
    expect(Date.now() - t0).toBeLessThan(BOUND * 2 + 400);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("timed out");
    expect(counter("prefetch:timeout") - before).toBe(2);
  });

  // A real socket: the TCP connection is accepted and the request read, but no
  // byte is ever written back.
  const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {} } });
  afterAll(() => silent.stop(true));

  test("a TCP socket that accepts and never answers: prefetch and sync give up within the bound", async () => {
    const client = new NodeClient({ baseUrl: `http://127.0.0.1:${silent.port}`, token: "t", memoryTimeoutMs: BOUND });
    const p = makeNodeMemoryProvider({ client, tokenFor: () => "tok", warn: () => {} });
    const t0 = Date.now();
    expect(await p.prefetch("s1")).toBeNull();
    await p.syncTurn({ sessionId: "s1", user: "u", assistant: "a" });
    expect(Date.now() - t0).toBeLessThan(BOUND * 2 + 600);
  });

  test("a 5xx is not retried", async () => {
    let calls = 0;
    const client = new NodeClient({
      baseUrl: "http://gw", token: "t", baseDelayMs: 1,
      fetchImpl: (async () => (calls++, new Response("{}", { status: 503 }))) as any,
    });
    const p = makeNodeMemoryProvider({ client, tokenFor: () => "tok", warn: () => {} });
    expect(await p.prefetch("s1")).toBeNull();
    expect(calls).toBe(1);
  });

  test("the transcript is clipped on the node before it is sent", async () => {
    let sent: any = null;
    const client = new NodeClient({
      baseUrl: "http://gw", token: "t",
      fetchImpl: (async (_u: string, init: RequestInit) => ((sent = JSON.parse(String(init.body))), Response.json({ ok: true }))) as any,
    });
    const p = makeNodeMemoryProvider({ client, tokenFor: () => "tok", warn: () => {} });
    await p.syncTurn({ sessionId: "s1", user: "u".repeat(50_000), assistant: "short" });
    expect(sent.user.length).toBe(MEMORY_TURN_MAX_CHARS + 1);
    expect(sent.assistant).toBe("short");
  });
});
