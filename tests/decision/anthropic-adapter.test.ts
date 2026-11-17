import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import "../../src/decision/adapters/index";
import { ANTHROPIC_DEFAULT_MODEL, MAX_STATE_CHARS, makeAnthropicAdapter } from "../../src/decision/adapters/anthropic";
import { adapterFromConfig, decide } from "../../src/decision/registry";
import { GATE_QUESTIONS } from "../../src/gateway/gate/questions";
import { DecisionError, type DecisionErrorKind } from "../../src/decision/types";

/** A fake provider on a loopback port: no real network. */
type Reply = { status?: number; body?: unknown; raw?: string; hang?: boolean; stream?: boolean };
let reply: Reply = {};
const seen: Array<{ path: string; headers: Record<string, string>; body: any }> = [];
let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({ path: url.pathname, headers: Object.fromEntries(req.headers), body: await req.json().catch(() => null) });
      if (reply.hang) return new Promise<Response>((res) => req.signal.addEventListener("abort", () => res(new Response(null, { status: 499 }))));
      if (reply.stream) {
        // Never finishes: only a reader that stops at its cap returns.
        const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
        return new Response(new ReadableStream({ pull: (c) => new Promise((r) => setTimeout(() => { try { c.enqueue(chunk); } catch { /* the reader cancelled at its cap */ } r(undefined); }, 1)) }));
      }
      if (reply.raw !== undefined) return new Response(reply.raw, { status: reply.status ?? 200 });
      return Response.json(reply.body ?? {}, { status: reply.status ?? 200 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
  void server.stop(true); // not awaited: a hung request would hold it
});
afterEach(() => {
  seen.length = 0;
  reply = {};
});

const toolUse = (input: unknown) => ({ content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "answer_questions", input }] });
const good = (q: Record<string, unknown> = GATE_QUESTIONS) => toolUse(Object.fromEntries(Object.keys(q).map((k) => [k, { choice: "yes", confidence: 0.9 }])));
const adapter = (headers: Record<string, string> = { "x-api-key": "test-key-value" }) => makeAnthropicAdapter({ baseUrl: base, headers, model: "small-test-model" });
const req = (questions: Record<string, any> = GATE_QUESTIONS) => ({ state: { message: "<agent> can you look?", recent: [] }, questions });
const sig = (ms = 2000) => AbortSignal.timeout(ms);

describe("anthropic adapter", () => {
  test("asks the Messages API once with the configured model and returns an answer per question", async () => {
    reply = { body: good() };
    const out = await adapter().decide(req(), sig());
    expect(Object.keys(out).sort()).toEqual(Object.keys(GATE_QUESTIONS).sort());
    expect(out.addressedToAgent).toEqual({ choice: "yes", confidence: 0.9 });
    expect(seen).toHaveLength(1);
    const s = seen[0]!;
    expect(s.path).toBe("/v1/messages");
    expect(s.headers["x-api-key"]).toBe("test-key-value");
    expect(s.body.model).toBe("small-test-model");
    expect(s.body.tool_choice).toEqual({ type: "tool", name: "answer_questions" });
    expect(Object.keys(s.body.tools[0].input_schema.properties).sort()).toEqual(Object.keys(GATE_QUESTIONS).sort());
    expect(s.body.tools[0].input_schema.properties.addressedToAgent.properties.choice.enum).toEqual(["yes", "no"]);
    expect(String(s.body.system)).toContain("untrusted");
  });
  test("one question at addressed is one answer", async () => {
    const q = { addressedToAgent: GATE_QUESTIONS.addressedToAgent };
    reply = { body: good(q) };
    expect(Object.keys(await adapter().decide(req(q), sig()))).toEqual(["addressedToAgent"]);
  });
  test("works through the registry's decide, which validates again", async () => {
    reply = { body: good() };
    const out = await decide(adapter(), req(), 2000);
    expect(out.agentCanHelp?.choice).toBe("yes");
  });

  const malformed: Array<[string, Reply]> = [
    ["not JSON", { raw: "<html>" }],
    ["no tool call", { body: { content: [{ type: "text", text: "yes" }] } }],
    ["a different tool", { body: { content: [{ type: "tool_use", name: "other", input: {} }] } }],
    ["a missing question", { body: toolUse({ addressedToAgent: { choice: "yes", confidence: 1 } }) }],
    ["an undeclared option", { body: toolUse(Object.fromEntries(Object.keys(GATE_QUESTIONS).map((k) => [k, { choice: "maybe", confidence: 1 }]))) }],
    ["a confidence above 1", { body: toolUse(Object.fromEntries(Object.keys(GATE_QUESTIONS).map((k) => [k, { choice: "yes", confidence: 2 }]))) }],
    ["a string confidence", { body: toolUse(Object.fromEntries(Object.keys(GATE_QUESTIONS).map((k) => [k, { choice: "yes", confidence: "0.9" }]))) }],
    ["an array as input", { body: toolUse([]) }],
    ["an oversized body", { raw: JSON.stringify({ pad: "x".repeat(70_000) }) }],
    ["an oversized body with no end (a stream)", { stream: true }],
  ];
  for (const [name, r] of malformed) {
    test(`malformed (${name}) is a bad_output error`, async () => {
      reply = r;
      const e = await adapter().decide(req(), sig()).catch((x) => x);
      expect(e).toBeInstanceOf(DecisionError);
      expect((e as DecisionError).kind).toBe("bad_output");
    });
  }

  const statuses: Array<[number, DecisionErrorKind]> = [[401, "auth"], [403, "auth"], [400, "invalid_request"], [429, "rate_limited"], [529, "overloaded"], [500, "transport"]];
  for (const [status, kind] of statuses) {
    test(`HTTP ${status} is ${kind}`, async () => {
      reply = { status, body: { error: { message: "echoes: secret chat text" } } };
      const e = await adapter().decide(req(), sig()).catch((x) => x);
      expect((e as DecisionError).kind).toBe(kind);
      expect((e as Error).message).not.toContain("secret chat text");
    });
  }

  test("an abort is a timeout, and a hung provider does not outlive it", async () => {
    reply = { hang: true };
    const t0 = Date.now();
    const e = await adapter().decide(req(), AbortSignal.timeout(60)).catch((x) => x);
    expect((e as DecisionError).kind).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  test("an already aborted signal makes no request", async () => {
    const c = new AbortController();
    c.abort();
    const e = await adapter().decide(req(), c.signal).catch((x) => x);
    expect(e).toBeInstanceOf(DecisionError);
    expect(seen).toHaveLength(0);
  });
  test("a connection failure is a transport error with no address in it", async () => {
    const dead = makeAnthropicAdapter({ baseUrl: "http://127.0.0.1:1", headers: {}, model: "m" });
    const e = await dead.decide(req(), sig()).catch((x) => x);
    expect((e as DecisionError).kind).toBe("transport");
    expect((e as Error).message).not.toContain("127.0.0.1");
  });
  test("a state over the adapter's own limit is refused, not cut", async () => {
    const e = await adapter().decide({ state: { message: "x".repeat(MAX_STATE_CHARS) }, questions: GATE_QUESTIONS }, sig()).catch((x) => x);
    expect((e as DecisionError).kind).toBe("invalid_request");
    expect(seen).toHaveLength(0);
  });
  test("never logs the key or the message text", async () => {
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((m) => spyOn(console, m));
    reply = { body: good() };
    await adapter().decide({ state: { message: "private message text" }, questions: GATE_QUESTIONS }, sig());
    reply = { status: 500 };
    await adapter().decide(req(), sig()).catch(() => {});
    const logged = spies.flatMap((s) => s.mock.calls.map((c) => c.join(" "))).join("\n");
    spies.forEach((s) => s.mockRestore());
    expect(logged).not.toMatch(/test-key-value|private message text/);
  });
});

describe("the registered anthropic adapter", () => {
  const keys = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of keys) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  });
  const clear = () => keys.forEach((k) => delete process.env[k]);
  const build = (block: unknown) => adapterFromConfig(block, { resolveSecret: async () => "" });

  test("is built from the gateway's provider environment, with a default small model on the public API host", async () => {
    clear();
    process.env.ANTHROPIC_API_KEY = "env-key-value";
    process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
    expect((await build({ type: "anthropic" }))?.name).toBe("anthropic");
    expect(ANTHROPIC_DEFAULT_MODEL).toBe("claude-haiku-5-5");
  });
  test("a non-default provider host with no model in the block disables the adapter with one warning naming the field, not the value", async () => {
    clear();
    process.env.ANTHROPIC_API_KEY = "env-key-value";
    process.env.ANTHROPIC_BASE_URL = base;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(await build({ type: "anthropic" })).toBeNull();
    const out = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    warn.mockRestore();
    expect(out).toContain("adapter.model");
    expect(out).not.toContain(base);
    // naming the model is what makes a custom provider usable
    expect((await build({ type: "anthropic", model: "provider-small" }))?.name).toBe("anthropic");
  });
  test("a model is sent to a custom provider, and the default model id is used on the public host", async () => {
    clear();
    process.env.ANTHROPIC_API_KEY = "env-key-value";
    process.env.ANTHROPIC_BASE_URL = base;
    const a = await build({ type: "anthropic", model: ANTHROPIC_DEFAULT_MODEL });
    expect(a?.name).toBe("anthropic");
    reply = { body: good() };
    await a!.decide(req(), sig());
    expect(seen[0]!.headers["x-api-key"]).toBe("env-key-value");
    expect(seen[0]!.body.model).toBe("claude-haiku-5-5");
  });
  test("the block's model is used; a bearer token and the OAuth token are accepted in turn", async () => {
    clear();
    process.env.ANTHROPIC_AUTH_TOKEN = "tok";
    process.env.ANTHROPIC_BASE_URL = base;
    reply = { body: good() };
    await (await build({ type: "anthropic", model: "my-small-model" }))!.decide(req(), sig());
    expect(seen[0]!.headers.authorization).toBe("Bearer tok");
    expect(seen[0]!.body.model).toBe("my-small-model");
    clear();
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth";
    process.env.ANTHROPIC_BASE_URL = base;
    await (await build({ type: "anthropic", model: "m" }))!.decide(req(), sig());
    expect(seen[1]!.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });
  test("an apiKey secret reference is resolved at boot and preferred over every provider variable, as x-api-key", async () => {
    clear();
    process.env.ANTHROPIC_API_KEY = "env-key-value";
    process.env.ANTHROPIC_AUTH_TOKEN = "tok";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth";
    process.env.ANTHROPIC_BASE_URL = base;
    const asked: string[] = [];
    reply = { body: good() };
    const a = await adapterFromConfig({ type: "anthropic", model: "m", apiKey: "env://PERSONA_DECISION_API_KEY" }, { resolveSecret: async (r) => (asked.push(r), "ref-key-value") });
    await a!.decide(req(), sig());
    expect(asked).toEqual(["env://PERSONA_DECISION_API_KEY"]);
    const h = seen.at(-1)!.headers;
    expect(h["x-api-key"]).toBe("ref-key-value");
    expect(h.authorization).toBeUndefined();
    expect(h["anthropic-beta"]).toBeUndefined();
  });
  test("a reference alone is enough; its value never reaches a warning or an error", async () => {
    clear();
    process.env.ANTHROPIC_BASE_URL = base;
    reply = { status: 401, body: { error: "ref-key-value" } };
    const a = await adapterFromConfig({ type: "anthropic", model: "m", apiKey: "env://PERSONA_DECISION_API_KEY" }, { resolveSecret: async () => "ref-key-value" });
    const err = await a!.decide(req(), sig()).catch((e) => e);
    expect(String(err.message)).not.toContain("ref-key-value");
  });
  test("a literal key, a malformed reference or an unresolved one disables the adapter, echoing nothing", async () => {
    clear();
    process.env.ANTHROPIC_API_KEY = "env-key-value";
    process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(await adapterFromConfig({ type: "anthropic", apiKey: "sk-literal-secret-value" }, { resolveSecret: async () => "x" })).toBeNull();
    expect(await adapterFromConfig({ type: "anthropic", apiKey: "env://PERSONA_MISSING" }, { resolveSecret: async () => { throw new Error("no such secret leaky-value"); } })).toBeNull();
    const out = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    warn.mockRestore();
    expect(out).not.toContain("sk-literal-secret-value");
    expect(out).not.toContain("leaky-value");
  });
  test("a reference that resolves empty disables the adapter and never falls back to the provider key", async () => {
    clear();
    process.env.ANTHROPIC_API_KEY = "env-key-value";
    process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(await adapterFromConfig({ type: "anthropic", apiKey: "env://PERSONA_DECISION_API_KEY" }, { resolveSecret: async () => "" })).toBeNull();
    warn.mockRestore();
  });
  test("without apiKey the adapter behaves as before (the API key variable)", async () => {
    clear();
    process.env.ANTHROPIC_API_KEY = "env-key-value";
    process.env.ANTHROPIC_BASE_URL = base;
    reply = { body: good() };
    await (await build({ type: "anthropic", model: "m" }))!.decide(req(), sig());
    expect(seen.at(-1)!.headers["x-api-key"]).toBe("env-key-value");
  });
  test("no credentials or an unknown key disables the adapter, naming nothing", async () => {
    clear();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(await build({ type: "anthropic" })).toBeNull();
    process.env.ANTHROPIC_API_KEY = "k";
    process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
    expect(await build({ type: "anthropic", bogus: "x" })).toBeNull();
    expect(await build({ type: "anthropic", model: "" })).toBeNull();
    const out = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    warn.mockRestore();
    expect(out).not.toContain("env-key");
  });
});
