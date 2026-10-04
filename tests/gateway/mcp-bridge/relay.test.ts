/**
 * The MCP bridge relays, gateway side, against a real streamable-HTTP MCP
 * server (WS-C §4.2.2/§4.2.3/§4.2.8): tool definitions arrive byte-equal to the
 * upstream's own (JSON Schema, outputSchema, annotations, _meta), instructions
 * survive, image / isError / structuredContent results pass through, an
 * unknown tool is a tool error, a big result is truncated with a message, an
 * aborted call cancels the upstream, an expired upstream session reconnects,
 * and the per-owner concurrency limit queues.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createMcpBridge, truncatedText, cancelledText, timeoutText, type BridgeLimits } from "../../../src/gateway/core/mcp-bridge";
import type { JobClaims } from "../../../src/gateway/api/auth";
import { INSTRUCTIONS, PNG_1PX, TOOLS, startUpstream } from "./upstream";

const sse = startUpstream();
const json = startUpstream({ json: true });
afterAll(() => {
  sse.stop();
  json.stop();
});

const claims = (runAs = "agent"): JobClaims => ({
  tenant: "t1", persona: "default", session: "S1", team: "TTEAM", channel: "CCHAN", thread: "1.1",
  initiator: "UUSER1", scope: "turn", runAs, exp: 0,
});

const LIMITS: BridgeLimits = { timeoutMs: 5000, ownerConcurrency: 4, maxRequestBytes: 1 << 20, maxResultBytes: 64 * 1024 };
const loopback = { allowLoopback: true, allowedHosts: [], internalHosts: [] };

function bridgeFor(url: string, o: { limits?: Partial<BridgeLimits>; timeout?: number } = {}) {
  return createMcpBridge({
    servers: () => ({ servers: { example: { type: "http", url, ...(o.timeout ? { timeout: o.timeout } : {}) } as never }, privateServices: [] }),
    accountFor: async () => null,
    credentialsFor: async () => ({}),
    policy: loopback,
    limits: () => ({ ...LIMITS, ...o.limits }),
  });
}

const until = async (pred: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** tools/call requests the SSE upstream has received so far. */
const toolCalls = () => sse.methods.filter((m) => m === "tools/call").length;
/** Wait until a call made after `seen` reached the upstream. */
const untilCallReached = (seen: number) => until(() => toolCalls() > seen);

for (const [mode, up] of [["SSE", sse], ["JSON", json]] as const) {
  describe(`relay fidelity (${mode} responses)`, () => {
    const bridge = bridgeFor(up.url);
    afterAll(() => bridge.close());

    test("tool definitions are byte-equal to the upstream's, with its instructions and server info", async () => {
      const out = await bridge.list(claims(), "example");
      expect(out.unavailable).toBeUndefined();
      expect(JSON.stringify(out.tools)).toBe(JSON.stringify(TOOLS));
      expect(out.instructions).toBe(INSTRUCTIONS);
      expect(out.serverInfo).toMatchObject({ name: "example-upstream", version: "9.9.9" });
    });

    test("arguments reach the upstream intact and the result returns unchanged", async () => {
      const args = { shape: { kind: "poly", points: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }] }, tags: ["a", "b"] };
      const r = await bridge.call(claims(), "example", "nested", args);
      expect(r).toEqual({ content: [{ type: "text", text: JSON.stringify(args) }] });
    });

    test("image, isError and structuredContent results pass through", async () => {
      expect(await bridge.call(claims(), "example", "image", {})).toEqual({
        content: [{ type: "image", data: PNG_1PX, mimeType: "image/png" }, { type: "text", text: "a pixel" }],
      });
      expect(await bridge.call(claims(), "example", "fail", {})).toEqual({
        content: [{ type: "text", text: "the example service said no" }],
        isError: true,
      });
      expect(await bridge.call(claims(), "example", "structured", { n: 21 })).toEqual({
        content: [{ type: "text", text: JSON.stringify({ doubled: 42 }) }],
        structuredContent: { doubled: 42 },
      });
    });
  });
}

describe("relay failures and limits", () => {
  let bridge = bridgeFor(sse.url);
  beforeEach(async () => {
    await bridge.close();
    bridge = bridgeFor(sse.url);
  });
  afterAll(() => bridge.close());

  test("notifications are not bridged: the standalone SSE stream is never opened", async () => {
    await bridge.call(claims(), "example", "echo", { text: "x" });
    await new Promise((r) => setTimeout(r, 50));
    expect(sse.verbs.length).toBeGreaterThan(0);
    expect(sse.verbs).not.toContain("GET");
  });

  test("an unknown tool is a tool error, not a failed request", async () => {
    const r = await bridge.call(claims(), "example", "no_such_tool", {});
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("no_such_tool");
  });

  test("a result over the cap is truncated with a clear message", async () => {
    const r = await bridge.call(claims(), "example", "big", { n: 200_000 });
    const content = r.content as { type: string; text: string }[];
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(LIMITS.maxResultBytes);
    expect(content.at(-1)!.text).toBe(truncatedText(Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: "x".repeat(200_000) }] })), LIMITS.maxResultBytes));
    expect(content[0]!.text.startsWith("xxxx")).toBe(true);
    // Text-only: nothing structured was dropped, so the result is not an error.
    expect(r.isError).toBe(false);
    // Under the cap: untouched.
    expect(await bridge.call(claims(), "example", "big", { n: 10 })).toEqual({ content: [{ type: "text", text: "x".repeat(10) }] });
  });

  test("aborting the call cancels it upstream", async () => {
    const before = sse.slowAborted;
    const cancelledBefore = sse.cancelled.length;
    const ac = new AbortController();
    const calls = toolCalls();
    const p = bridge.call(claims(), "example", "slow", {}, ac.signal);
    await untilCallReached(calls);
    ac.abort();
    const r = await p;
    expect(r).toEqual({ content: [{ type: "text", text: cancelledText("example") }], isError: true });
    await until(() => sse.slowAborted === before + 1);
    expect(sse.cancelled.length).toBe(cancelledBefore + 1);
  });

  test("a server's own timeout is honoured, with fixed text", async () => {
    const b = bridgeFor(sse.url, { timeout: 150 });
    try {
      const r = await b.call(claims(), "example", "slow", {});
      expect(r).toEqual({ content: [{ type: "text", text: timeoutText("example", 150) }], isError: true });
    } finally {
      await b.close();
    }
  });

  test("the gateway ceiling wins over a longer per-server timeout", async () => {
    const b = bridgeFor(sse.url, { timeout: 60_000, limits: { timeoutMs: 150 } });
    try {
      const r = await b.call(claims(), "example", "slow", {});
      expect(r.content).toEqual([{ type: "text", text: timeoutText("example", 150) }]);
    } finally {
      await b.close();
    }
  });

  test("an expired upstream session is re-initialised and the call retried once", async () => {
    expect((await bridge.call(claims(), "example", "echo", { text: "one" })).content).toEqual([{ type: "text", text: "one" }]);
    const inits = sse.methods.filter((m) => m === "initialize").length;
    sse.expireSessions();
    expect((await bridge.call(claims(), "example", "echo", { text: "two" })).content).toEqual([{ type: "text", text: "two" }]);
    expect(sse.methods.filter((m) => m === "initialize").length).toBe(inits + 1);
  });

  test("per-owner concurrency: a call over the limit waits for a slot", async () => {
    const b = bridgeFor(sse.url, { limits: { ownerConcurrency: 1 } });
    try {
      const ac = new AbortController();
      let calls = toolCalls();
      const slow = b.call(claims(), "example", "slow", {}, ac.signal);
      await untilCallReached(calls);
      let done = false;
      const echo = b.call(claims(), "example", "echo", { text: "queued" }).then((r) => {
        done = true;
        return r;
      });
      await new Promise((r) => setTimeout(r, 100));
      expect(done).toBe(false);
      // Another owner is not held up by this one's slots.
      expect((await b.call(claims("user:UOTHER"), "example", "echo", { text: "other" })).content).toEqual([{ type: "text", text: "other" }]);
      ac.abort();
      await slow;
      expect((await echo).content).toEqual([{ type: "text", text: "queued" }]);
      // A waiter whose call is aborted gives up its place.
      const ac2 = new AbortController();
      calls = toolCalls();
      const slow2 = b.call(claims(), "example", "slow", {}, ac2.signal);
      await untilCallReached(calls);
      const ac3 = new AbortController();
      const waiting = b.call(claims(), "example", "echo", { text: "never" }, ac3.signal);
      ac3.abort();
      expect(await waiting).toEqual({ content: [{ type: "text", text: cancelledText("example") }], isError: true });
      ac2.abort();
      await slow2;
    } finally {
      await b.close();
    }
  });

  test("an upstream that is down is a tool error with fixed text, not a failure", async () => {
    const gone = startUpstream();
    const url = gone.url;
    gone.stop();
    const b = bridgeFor(url);
    try {
      expect(await b.call(claims(), "example", "echo", { text: "x" })).toEqual({
        content: [{ type: "text", text: "example is unavailable right now; try again later" }],
        isError: true,
      });
      const listed = await b.list(claims(), "example");
      expect(listed).toEqual({ tools: [], instructions: "example is unavailable right now; try again later", unavailable: true });
    } finally {
      await b.close();
    }
  });

  test("a server the persona does not mount is refused before any upstream contact", async () => {
    await expect(bridge.call(claims(), "missing", "echo", {})).rejects.toMatchObject({ status: 404 });
    await expect(bridge.list(claims(), "missing")).rejects.toMatchObject({ status: 404 });
  });
});
