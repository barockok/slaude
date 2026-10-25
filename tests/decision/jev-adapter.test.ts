import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import "../../src/decision/adapters/jev";
import { makeJevAdapter } from "../../src/decision/adapters/jev";
import { adapterFromConfig } from "../../src/decision/registry";
import { DecisionError, type DecisionRequest } from "../../src/decision/types";

type Seen = { auth: string | null; body: any };
let seen: Seen[] = [];
let replies: Array<{ status: number; headers?: Record<string, string>; body?: string }> = [];
let server: ReturnType<typeof Bun.serve>;
let url: string;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      seen.push({ auth: req.headers.get("authorization"), body: await req.json().catch(() => null) });
      const r = replies.shift() ?? { status: 500 };
      return new Response(r.body ?? "", { status: r.status, headers: r.headers });
    },
  });
  url = `http://127.0.0.1:${server.port}/v1/systemone`;
});
afterAll(() => server.stop(true));
beforeEach(() => {
  seen = [];
  replies = [];
});

const req: DecisionRequest = {
  state: { text: "hi" },
  questions: { q: { instructions: "Pick one", options: { yes: "Yes it is", no: "No it is not" } } },
};
const ok = (choice = "no", confidence = 0.9) => ({
  status: 200,
  body: JSON.stringify({ answers: { q: { type: "choice", choice, probabilities: { yes: 0.1, no: 0.9 }, confidence } } }),
});
const mk = () => makeJevAdapter({ url, apiKey: "k", model: "m1", outboundOpts: { allowLoopback: true } });
const kind = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e instanceof DecisionError ? e.kind : "other"; }
  return "none";
};

describe("jev adapter", () => {
  it("maps a neutral request to Jev: model, state, choice questions with option criteria, bearer auth", async () => {
    replies.push(ok());
    await mk().decide(req, AbortSignal.timeout(800));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.auth).toBe("Bearer k");
    const b = seen[0]!.body;
    expect(b.model).toBe("m1");
    expect(b.state).toEqual({ text: "hi" });
    expect(b.questions.q.type).toBe("choice");
    expect(b.questions.q.instructions).toBe("Pick one");
    expect(b.questions.q.criteria).toEqual(req.questions.q!.options);
  });

  it("maps Jev answers back to { choice, confidence }", async () => {
    replies.push(ok("no", 0.9));
    expect(await mk().decide(req, AbortSignal.timeout(800))).toEqual({ q: { choice: "no", confidence: 0.9 } });
  });

  it("401 throws auth without retry", async () => {
    replies.push({ status: 401 });
    expect(await kind(mk().decide(req, AbortSignal.timeout(800)))).toBe("auth");
    expect(seen).toHaveLength(1);
  });

  it("422 throws invalid_request; 500 throws transport", async () => {
    replies.push({ status: 422 });
    expect(await kind(mk().decide(req, AbortSignal.timeout(800)))).toBe("invalid_request");
    replies.push({ status: 500 });
    expect(await kind(mk().decide(req, AbortSignal.timeout(800)))).toBe("transport");
  });

  it("429 with retry-after inside the remaining time retries once", async () => {
    replies.push({ status: 429, headers: { "retry-after": "0" } }, ok());
    expect(await mk().decide(req, AbortSignal.timeout(800))).toEqual({ q: { choice: "no", confidence: 0.9 } });
    expect(seen).toHaveLength(2);
  });

  it("a second 429 after the retry throws rate_limited (one retry only)", async () => {
    replies.push({ status: 429, headers: { "retry-after": "0" } }, { status: 429, headers: { "retry-after": "0" } });
    expect(await kind(mk().decide(req, AbortSignal.timeout(800)))).toBe("rate_limited");
    expect(seen).toHaveLength(2);
  });

  it("529 with retry-after beyond the remaining time throws overloaded without retry", async () => {
    replies.push({ status: 529, headers: { "retry-after": "5" } });
    expect(await kind(mk().decide(req, AbortSignal.timeout(800)))).toBe("overloaded");
    expect(seen).toHaveLength(1);
  });

  it("429 without retry-after does not retry", async () => {
    replies.push({ status: 429 });
    expect(await kind(mk().decide(req, AbortSignal.timeout(800)))).toBe("rate_limited");
    expect(seen).toHaveLength(1);
  });

  it("a non-JSON or answer-less 200 throws bad_output", async () => {
    replies.push({ status: 200, body: "not json" });
    expect(await kind(mk().decide(req, AbortSignal.timeout(800)))).toBe("bad_output");
    replies.push({ status: 200, body: JSON.stringify({ answers: {} }) });
    expect(await kind(mk().decide(req, AbortSignal.timeout(800)))).toBe("bad_output");
    replies.push({ status: 200, body: JSON.stringify({}) });
    expect(await kind(mk().decide(req, AbortSignal.timeout(800)))).toBe("bad_output");
  });

  it("a connection failure throws transport", async () => {
    const a = makeJevAdapter({ url: "http://127.0.0.1:1/x", apiKey: "k", model: "m", outboundOpts: { allowLoopback: true } });
    expect(await kind(a.decide(req, AbortSignal.timeout(800)))).toBe("transport");
  });
});

describe("jev factory", () => {
  let warn: ReturnType<typeof spyOn>;
  beforeEach(() => { warn = spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => warn.mockRestore());
  const resolveSecret = async (ref: string) => (ref === "env://PERSONA_JEV_KEY" ? "secret-key" : Promise.reject(new Error("no")));

  it("env:// apiKey resolves; a literal apiKey or a missing apiKey is rejected", async () => {
    const a = await adapterFromConfig({ type: "jev", apiKey: "env://PERSONA_JEV_KEY" }, { resolveSecret });
    expect(a?.name).toBe("jev");
    expect(await adapterFromConfig({ type: "jev", apiKey: "sk-live-x" }, { resolveSecret })).toBeNull();
    expect(await adapterFromConfig({ type: "jev" }, { resolveSecret })).toBeNull();
  });

  it("accepts a vault:// reference", async () => {
    const a = await adapterFromConfig({ type: "jev", apiKey: "vault://kv/jev#key" }, { resolveSecret: async () => "v" });
    expect(a?.name).toBe("jev");
  });

  it("url and model default when omitted; unknown block keys and bad fields rejected", async () => {
    const a = await adapterFromConfig({ type: "jev", apiKey: "env://PERSONA_JEV_KEY", url: url, model: "custom" }, { resolveSecret });
    expect(a?.name).toBe("jev");
    expect(await adapterFromConfig({ type: "jev", apiKey: "env://PERSONA_JEV_KEY", extra: 1 }, { resolveSecret })).toBeNull();
    expect(await adapterFromConfig({ type: "jev", apiKey: "env://PERSONA_JEV_KEY", url: "not a url" }, { resolveSecret })).toBeNull();
    expect(await adapterFromConfig({ type: "jev", apiKey: "env://PERSONA_JEV_KEY", model: "" }, { resolveSecret })).toBeNull();
  });
});
