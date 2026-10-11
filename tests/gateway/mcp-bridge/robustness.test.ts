/**
 * The bridge recovers and stays bounded (review M2, M3, m5, F4, F5):
 *   - an upstream that restarted (and answers 400 for the old session) is
 *     reached again on a fresh session, every call;
 *   - a pooled session idle past the expiry is reopened;
 *   - a tool list is capped by count and bytes, paging stops, and a fixed
 *     notice says so;
 *   - an aborted call drops its HTTP connection, not only sends a cancel;
 *   - an answer on an event stream the upstream keeps open returns at once
 *     and the connection is closed after the call;
 *   - a truncated result that had structuredContent is an error.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { capResult, createMcpBridge, interruptedText, listTruncatedText, type BridgeLimits } from "../../../src/gateway/core/mcp-bridge";
import type { JobClaims } from "../../../src/gateway/api/auth";
import { TOOLS, startUpstream, type Upstream } from "./upstream";

const claims: JobClaims = {
  tenant: "t1", persona: "default", session: "S1", team: "TTEAM", channel: "CCHAN", thread: "1.1",
  initiator: "UUSER1", scope: "turn", runAs: "agent", exp: 0,
};
const LIMITS: BridgeLimits = { timeoutMs: 5000, ownerConcurrency: 4, maxRequestBytes: 1 << 20, maxResultBytes: 1 << 20 };
const ups: Upstream[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterAll(() => {
  for (const u of ups) u.stop();
  for (const s of servers) s.stop(true);
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
const until = async (pred: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("recovery", () => {
  test("an upstream that restarted and answers 400 for the old session is reached on a fresh one", async () => {
    const up = upstream({ unknownSessionStatus: 400 });
    const b = bridgeAt(up.url);
    try {
      expect((await b.call(claims, "s", "echo", { text: "before" })).content).toEqual([{ type: "text", text: "before" }]);
      up.restart();
      for (let i = 0; i < 3; i++) {
        expect((await b.call(claims, "s", "echo", { text: `after ${i}` })).content).toEqual([{ type: "text", text: `after ${i}` }]);
      }
      expect(up.methods.filter((m) => m === "initialize")).toHaveLength(2);
    } finally {
      await b.close();
    }
  });

  test("a pooled session idle past the expiry is reopened", async () => {
    const up = upstream();
    // A controlled clock: real time only moves the deadline, never the idle check.
    let clock = Date.now();
    const b = bridgeAt(up.url, { idleMs: 60_000 }, () => clock);
    try {
      await b.call(claims, "s", "echo", { text: "a" });
      await b.call(claims, "s", "echo", { text: "b" });
      expect(up.methods.filter((m) => m === "initialize")).toHaveLength(1);
      clock += 61_000;
      await b.call(claims, "s", "echo", { text: "c" });
      expect(up.methods.filter((m) => m === "initialize")).toHaveLength(2);
    } finally {
      await b.close();
    }
  });
});

describe("a pooled session shared by concurrent calls (review R1)", () => {
  for (const json of [false, true]) {
    for (const n of [2, 8]) {
      test(`${n} concurrent calls across upstream restarts all succeed, on ONE fresh session per restart (${json ? "JSON" : "SSE"})`, async () => {
        const up = upstream({ unknownSessionStatus: 400, json });
        const b = bridgeAt(up.url, { sessionConcurrency: 16, ownerConcurrency: 16 });
        try {
          await b.call(claims, "s", "echo", { text: "warm" });
          for (let round = 0; round < 5; round++) {
            up.restart();
            const rs = await Promise.all(
              Array.from({ length: n }, (_, i) => b.call({ ...claims, session: `S-${i}` }, "s", "echo", { text: `r${round}-${i}` })),
            );
            rs.forEach((r, i) => expect(r).toEqual({ content: [{ type: "text", text: `r${round}-${i}` }] }));
          }
          expect(up.methods.filter((m) => m === "initialize")).toHaveLength(6);
          expect(up.sessions()).toBe(1);
        } finally {
          await b.close();
        }
      });
    }
  }

  test("one thread's 502 does not abort another thread's call in flight on the same pooled session", async () => {
    const up = upstream();
    const b = bridgeAt(up.url);
    try {
      await b.call(claims, "s", "echo", { text: "warm" });
      const ac = new AbortController();
      let settled = false;
      const slow = b.call({ ...claims, session: "S-A" }, "s", "slow", {}, ac.signal).then((r) => ((settled = true), r));
      await until(() => up.methods.filter((m) => m === "tools/call").length === 2);
      expect((await b.call({ ...claims, session: "S-B" }, "s", "fault_502", {})).content).toEqual([{ type: "text", text: interruptedText("s") }]);
      await new Promise((r) => setTimeout(r, 200));
      expect(settled).toBe(false);
      ac.abort();
      expect((await slow).content).toEqual([{ type: "text", text: "the call to s was cancelled" }]);
    } finally {
      await b.close();
    }
  });
});

describe("tool calls are at most once", () => {
  for (const name of ["fault_502", "fault_drop"]) {
    test(`${name}: the upstream ran the call once; the bridge does not retry and says it may have run`, async () => {
      const up = upstream();
      const b = bridgeAt(up.url);
      try {
        const r = await b.call(claims, "s", name, {});
        expect(r).toEqual({ content: [{ type: "text", text: interruptedText("s") }], isError: true });
        expect(up.executed[name]).toBe(1);
        expect(up.methods.filter((m) => m === "tools/call")).toHaveLength(1);
      } finally {
        await b.close();
      }
    });
  }

  for (const name of ["sse_drop", "sse_primed_drop", "sse_close"]) {
    test(`${name}: an answer stream that breaks or ends with no response after the call was sent: ran once, "may have run"`, async () => {
      const up = upstream();
      const b = bridgeAt(up.url, { timeoutMs: 400 });
      try {
        const r = await b.call(claims, "s", name, {});
        expect(r).toEqual({ content: [{ type: "text", text: interruptedText("s") }], isError: true });
        expect(up.executed[name]).toBe(1);
      } finally {
        await b.close();
      }
    });
  }

  test("a stale session (400 before the tool runs) is retried once on a fresh session and succeeds", async () => {
    const up = upstream({ unknownSessionStatus: 400 });
    const b = bridgeAt(up.url);
    try {
      await b.call(claims, "s", "echo", { text: "warm" });
      up.restart();
      expect((await b.call(claims, "s", "echo", { text: "again" })).content).toEqual([{ type: "text", text: "again" }]);
      // The rejected request plus one retry.
      expect(up.methods.filter((m) => m === "tools/call")).toHaveLength(3);
      expect(up.methods.filter((m) => m === "initialize")).toHaveLength(2);
    } finally {
      await b.close();
    }
  });
});

describe("tool list caps", () => {
  test("capped by count: paging stops and a fixed notice is appended to the instructions", async () => {
    const up = upstream({ extraTools: 40, pageSize: 5 });
    const b = bridgeAt(up.url, { maxTools: 12 });
    try {
      const out = await b.list(claims, "s");
      expect(out.tools).toHaveLength(12);
      expect(JSON.stringify(out.tools.slice(0, TOOLS.length))).toBe(JSON.stringify(TOOLS));
      expect(out.instructions).toEndWith(listTruncatedText(12, 12, 1024 * 1024));
      // 12 tools need 3 pages of 5; the 4th is never asked for.
      expect(up.methods.filter((m) => m === "tools/list")).toHaveLength(3);
    } finally {
      await b.close();
    }
  });

  test("capped by bytes", async () => {
    const up = upstream({ extraTools: 100 });
    const b = bridgeAt(up.url, { maxListBytes: 8 * 1024 });
    try {
      const out = await b.list(claims, "s");
      expect(Buffer.byteLength(JSON.stringify(out.tools))).toBeLessThanOrEqual(8 * 1024 + out.tools.length + 2);
      expect(out.tools.length).toBeLessThan(TOOLS.length + 100);
      expect(out.instructions).toContain("[tool list truncated by the MCP bridge:");
    } finally {
      await b.close();
    }
  });

  test("under the caps the list is complete and carries no notice", async () => {
    const up = upstream({ extraTools: 3, pageSize: 2 });
    const b = bridgeAt(up.url);
    try {
      const out = await b.list(claims, "s");
      expect(out.tools).toHaveLength(TOOLS.length + 3);
      expect(out.instructions).not.toContain("truncated");
    } finally {
      await b.close();
    }
  });
});

describe("connections", () => {
  test("an aborted call drops its HTTP connection to the upstream", async () => {
    const up = upstream();
    const b = bridgeAt(up.url);
    try {
      const ac = new AbortController();
      const p = b.call(claims, "s", "slow", {}, ac.signal);
      await until(() => up.methods.includes("tools/call"));
      ac.abort();
      await p;
      await until(() => up.httpAborts === 1);
    } finally {
      await b.close();
    }
  });

  test("an answer on an event stream the upstream keeps open returns at once; the stream is closed after", async () => {
    // A minimal MCP server that answers every request on an SSE stream it never closes.
    let open = 0;
    let closed = 0;
    const s = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      async fetch(req) {
        if (req.method !== "POST") return new Response(null, { status: 405 });
        const msg = (await req.json()) as { id?: number; method: string };
        if (msg.id === undefined) return new Response(null, { status: 202 });
        const result =
          msg.method === "initialize"
            ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "held", version: "1" } }
            : { content: [{ type: "text", text: "held answer" }] };
        open++;
        req.signal.addEventListener("abort", () => void closed++, { once: true });
        const body = new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`));
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream", "mcp-session-id": randomUUID() } });
      },
    });
    servers.push(s);
    const b = bridgeAt(`http://127.0.0.1:${s.port}/mcp`, { timeoutMs: 3000 });
    try {
      const t0 = Date.now();
      const r = await b.call(claims, "s", "anything", {});
      expect(r).toEqual({ content: [{ type: "text", text: "held answer" }] });
      expect(Date.now() - t0).toBeLessThan(1500);
      // Both held streams (initialize and the call) are closed by the bridge.
      await until(() => closed === open && open === 2);
    } finally {
      await b.close();
    }
  });
});

describe("capResult", () => {
  test("a truncated result that had structuredContent is an error; text-only keeps its isError", () => {
    const big = "x".repeat(5000);
    const structured = capResult({ content: [{ type: "text", text: big }], structuredContent: { k: 1 } }, 1024);
    expect(structured.isError).toBe(true);
    expect(structured.structuredContent).toBeUndefined();
    expect(capResult({ content: [{ type: "text", text: big }] }, 1024).isError).toBe(false);
    expect(capResult({ content: [{ type: "text", text: big }], isError: true }, 1024).isError).toBe(true);
  });
});
