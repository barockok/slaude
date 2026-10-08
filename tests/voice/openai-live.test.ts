import { describe, it, expect, afterEach } from "bun:test";
import { OpenAILive } from "../../src/voice/provider/openai-live";
import { createProvider } from "../../src/voice/provider";
import { pcmToBase64 } from "../../src/voice/provider/types";
import { Conductor, AUTO_RESPONSE_WAIT_MS } from "../../src/voice/conductor";
import type { ChildMsg } from "../../src/voice/ipc";
import { FakeAudio, until } from "./fakes";

type Srv = { url: string; path: string; frames: any[]; send(obj: unknown): void; headers: Headers | null; stop(): void; closeClient(): void };
function fakeServer(onFrame?: (f: any, s: Srv) => void): Srv {
  let sock: any = null;
  const s: Srv = {
    url: "", path: "", frames: [], headers: null,
    send: (o) => sock?.send(JSON.stringify(o)),
    stop: () => server.stop(true),
    closeClient: () => sock?.close(1011, "bye"),
  };
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      s.headers = req.headers;
      const u = new URL(req.url);
      s.path = u.pathname + u.search;
      return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      open(ws) { sock = ws; },
      message(_ws, m) { const f = JSON.parse(String(m)); s.frames.push(f); onFrame?.(f, s); },
    },
  });
  s.url = `ws://localhost:${server.port}/v1/live/sessions`;
  return s;
}
const EXPIRES_IN = 3600;
const ack = (f: any, s: Srv) => {
  if (f.type === "session.start") {
    s.send({
      type: "session.started", event_id: "evt_started", client_event_id: f.event_id,
      session: { id: "live_1", model: "gpt-live-1", status: "active", expires_at: Math.floor(Date.now() / 1000) + EXPIRES_IN },
    });
  }
  if (f.type === "session.close") s.send({ type: "session.closed", event_id: "evt_closed", reason: "close_requested", usage: { seconds: 1 } });
};
const FAST = { outputGapMs: 40, inputGapMs: 40, delegateSettleMs: 0, closeTimeoutMs: 300, respondTimeoutMs: 2000 };
const audioDelta = () => ({ type: "session.output_audio.delta", delta: pcmToBase64(new Int16Array(4)) });

let srv: Srv | null = null;
afterEach(() => { void srv?.stop(); });

describe("OpenAILive", () => {
  it("connects with bearer auth and no query, and starts a client-delegation session", async () => {
    srv = fakeServer(ack);
    const p = new OpenAILive({ apiKey: "sk-test", model: "gpt-live-1", url: srv.url, ...FAST });
    await p.connect({ instructions: "be brief", tools: [{ name: "delegate", description: "ask the brain", parameters: { type: "object" } }], voice: "marin" });
    expect(srv.headers!.get("authorization")).toBe("Bearer sk-test");
    expect(srv.path).toBe("/v1/live/sessions");
    const st = srv.frames[0];
    expect(st.type).toBe("session.start");
    expect(st.session.model).toBe("gpt-live-1");
    expect(st.session.instructions.startsWith("be brief")).toBe(true);
    expect(st.session.instructions).toContain("Delegation policy:");
    expect(st.session.instructions).toContain("- delegate: ask the brain");
    expect(st.session.audio).toEqual({ format: { type: "audio/pcm", rate: 24000 }, output: { voice: "marin" } });
    expect(st.session.delegation).toEqual({ type: "client" });
    expect(st.session.input).toBeUndefined();
    expect(st.session.tools).toBeUndefined();
    expect(p.caps).toMatchObject({ inputRate: 24000, outputRate: 24000, truncate: false });
    expect(p.caps.maxSessionSec!).toBeGreaterThan(EXPIRES_IN - 10);
    expect(p.caps.maxSessionSec!).toBeLessThanOrEqual(EXPIRES_IN);
    await p.close();
  });

  it("restores the seed as startup history, not as a later append", async () => {
    srv = fakeServer(ack);
    const p = new OpenAILive({ apiKey: "k", model: "gpt-live-1", url: srv.url, ...FAST });
    await p.connect({ instructions: "", tools: [], seed: "earlier: user asked X" });
    const input = srv.frames[0].session.input;
    expect(input).toHaveLength(1);
    expect(input[0]).toMatchObject({ type: "message", role: "developer" });
    expect(input[0].content[0].type).toBe("input_text");
    expect(input[0].content[0].text).toContain("restored after reconnect");
    expect(input[0].content[0].text).toContain("earlier: user asked X");
    await Bun.sleep(30);
    expect(srv.frames).toHaveLength(1);
    await p.close();
  });

  it("maps client methods to frames", async () => {
    srv = fakeServer(ack);
    const p = new OpenAILive({ apiKey: "k", model: "m", url: srv.url, ...FAST });
    await p.connect({ instructions: "", tools: [] });
    p.sendAudio(new Int16Array([1, 2]));
    p.addContext("fact");
    await Promise.resolve(); // silent context flushes after one microtask
    p.addContext("Say this: hi");
    p.respond(); // same tick: the pending context becomes speech
    p.respond(); // nothing pending: a short instruction
    p.cancel(); // no frame
    p.truncate("a1", 100); // no frame
    p.toolResult("del_1", { id: "1", status: "working" });
    await until(() => srv!.frames.length >= 6);
    await Bun.sleep(30);
    expect(srv.frames.map((f) => f.type)).toEqual(["session.start", "session.input_audio.append", "session.thinking.append",
      "session.commentary.append", "session.instructions.append", "session.thinking.append"]);
    expect(srv.frames[1]).toEqual({ type: "session.input_audio.append", audio: pcmToBase64(new Int16Array([1, 2])) });
    expect(srv.frames[2]).toEqual({ type: "session.thinking.append", delegation_id: null, content: "fact" });
    expect(srv.frames[3]).toEqual({ type: "session.commentary.append", delegation_id: null, content: "Say this: hi" });
    expect(srv.frames[4]).toMatchObject({ type: "session.instructions.append", delegation_id: null });
    expect(srv.frames[5]).toEqual({
      type: "session.thinking.append", delegation_id: "del_1",
      content: 'Backend status for this request: {"id":"1","status":"working"}',
    });
    await p.close();
  });

  it("caps append content at the 500-token limit", async () => {
    srv = fakeServer(ack);
    const p = new OpenAILive({ apiKey: "k", model: "m", url: srv.url, ...FAST });
    await p.connect({ instructions: "", tools: [] });
    p.addContext("x".repeat(5000));
    await until(() => srv!.frames.length >= 2);
    expect(srv.frames[1].content.length).toBe(1800);
    await p.close();
  });

  it("synthesizes turns, item ids, speech and responseDone from quiet gaps", async () => {
    srv = fakeServer(ack);
    const p = new OpenAILive({ apiKey: "k", model: "m", url: srv.url, ...FAST });
    const got: any[] = [];
    p.on("audio", (pcm, item) => got.push(["audio", pcm.length, item]));
    p.on("transcript", (t) => got.push(["transcript", t.role, t.text, t.itemId]));
    p.on("speechStarted", () => got.push(["speechStarted"]));
    p.on("speechStopped", () => got.push(["speechStopped"]));
    p.on("responseDone", () => got.push(["responseDone"]));
    p.on("error", (e) => got.push(["error", e.fatal]));
    await p.connect({ instructions: "", tools: [] });
    srv.send(audioDelta());
    srv.send({ type: "session.output_transcript.delta", event_id: "t1", delta: "hi ", start_ms: 0, end_ms: 100 });
    srv.send(audioDelta());
    srv.send({ type: "session.output_transcript.delta", event_id: "t2", delta: "there", start_ms: 100, end_ms: 200 });
    srv.send({ type: "session.usage.updated", event_id: "u1", usage: { seconds: 1 } }); // ignored
    await until(() => got.some((g) => g[0] === "responseDone"));
    srv.send({ type: "session.input_transcript.delta", event_id: "t3", delta: "hel", start_ms: 300, end_ms: 400 });
    srv.send({ type: "session.input_transcript.delta", event_id: "t4", delta: "lo", start_ms: 400, end_ms: 500 });
    await until(() => got.some((g) => g[0] === "speechStopped"));
    srv.send(audioDelta());
    await until(() => got.length >= 8);
    expect(got.slice(0, 8)).toEqual([
      ["audio", 4, "a1"], ["audio", 4, "a1"], ["transcript", "assistant", "hi there", "a1"], ["responseDone"],
      ["speechStarted"], ["transcript", "user", "hello", "u1"], ["speechStopped"], ["audio", 4, "a2"],
    ]);
    await p.close();
  });

  it("maps a client delegation to a delegate tool call built from the participant transcript", async () => {
    srv = fakeServer(ack);
    const p = new OpenAILive({ apiKey: "k", model: "m", url: srv.url, ...FAST, inputGapMs: 200 });
    const got: any[] = [];
    p.on("speechStarted", () => got.push(["speechStarted"]));
    p.on("transcript", (t) => got.push(["transcript", t.role, t.text]));
    p.on("toolCall", (c) => got.push(["toolCall", c.callId, c.name, c.args]));
    await p.connect({ instructions: "", tools: [] });
    srv.send({ type: "session.input_transcript.delta", event_id: "t1", delta: "what is the deploy status", start_ms: 0, end_ms: 900 });
    srv.send({ type: "session.delegation.created", event_id: "d0", offset_ms: 950, delegation: { id: "del_r", type: "delegation", target: "responses", response_id: "resp_1" } });
    srv.send({ type: "session.delegation.created", event_id: "d1", offset_ms: 1000, delegation: { id: "del_1", type: "delegation", target: "client" } });
    await until(() => got.some((g) => g[0] === "toolCall"));
    expect(got.slice(0, 3)).toEqual([
      ["speechStarted"], ["transcript", "user", "what is the deploy status"],
      ["toolCall", "del_1", "delegate", { task: "what is the deploy status" }],
    ]);
    srv.send({ type: "session.delegation.created", event_id: "d2", offset_ms: 2000, delegation: { id: "del_2", type: "delegation", target: "client" } });
    await until(() => got.filter((g) => g[0] === "toolCall").length >= 2);
    const second = got.filter((g) => g[0] === "toolCall")[1];
    expect(second[1]).toBe("del_2");
    expect(second[3].task).toContain("no new participant speech");
    expect(got.filter((g) => g[0] === "toolCall")).toHaveLength(2); // the responses-target one is ignored
    await p.close();
  });

  it("classifies errors and treats an unsolicited session.closed as a drop", async () => {
    srv = fakeServer(ack);
    const p = new OpenAILive({ apiKey: "k", model: "m", url: srv.url, ...FAST });
    const got: any[] = [];
    p.on("error", (e) => got.push(["error", e.fatal]));
    p.on("closed", () => got.push(["closed"]));
    await p.connect({ instructions: "", tools: [] });
    srv.send({ type: "error", event_id: "e1", error: { type: "invalid_request_error", code: "unknown_parameter", message: "bad" } });
    srv.send({ type: "error", event_id: "e2", error: { type: "invalid_request_error", code: "invalid_api_key", message: "no" } });
    srv.send({ type: "session.closed", event_id: "e3", reason: "expired", usage: { seconds: 3600 } });
    srv.closeClient();
    await until(() => got.length >= 4);
    await Bun.sleep(50);
    expect(got).toEqual([["error", false], ["error", true], ["error", false], ["closed"]]);
  });

  it("a safety close is fatal", async () => {
    srv = fakeServer(ack);
    const p = new OpenAILive({ apiKey: "k", model: "m", url: srv.url, ...FAST });
    const got: any[] = [];
    p.on("error", (e) => got.push(["error", e.fatal]));
    p.on("closed", () => got.push(["closed"]));
    await p.connect({ instructions: "", tools: [] });
    srv.send({ type: "session.closed", event_id: "e1", reason: "content", usage: { seconds: 5 } });
    await until(() => got.length >= 2);
    expect(got).toEqual([["error", true], ["closed"]]);
  });

  it("an unexpected socket close is non-fatal and fires closed", async () => {
    srv = fakeServer(ack);
    const p = new OpenAILive({ apiKey: "k", model: "m", url: srv.url, ...FAST });
    const got: any[] = [];
    p.on("error", (e) => got.push(["error", e.fatal]));
    p.on("closed", () => got.push(["closed"]));
    await p.connect({ instructions: "", tools: [] });
    srv.closeClient();
    await until(() => got.length >= 2);
    expect(got).toEqual([["error", false], ["closed"]]);
  });

  it("a rejected session.start fails the connect, closes its socket, and a stale close does not fire closed", async () => {
    srv = fakeServer((f, s) => {
      if (f.type === "session.start") {
        s.send({ type: "error", event_id: "e1", error: { type: "invalid_request_error", code: "unknown_parameter", message: "Unknown parameter: 'session.voice'.", param: "session.voice", client_event_id: f.event_id } });
      }
    });
    const p = new OpenAILive({ apiKey: "k", model: "m", url: srv.url, ...FAST });
    const got: any[] = [];
    p.on("error", (e) => got.push(["error", e.fatal]));
    p.on("closed", () => got.push(["closed"]));
    await expect(p.connect({ instructions: "", tools: [] })).rejects.toThrow("Unknown parameter");
    srv.closeClient();
    await Bun.sleep(100);
    expect(got).toEqual([["error", true]]);
  });

  it("connect() replaces an existing socket without firing closed", async () => {
    srv = fakeServer(ack);
    const p = new OpenAILive({ apiKey: "k", model: "m", url: srv.url, ...FAST });
    const got: any[] = [];
    p.on("closed", () => got.push(["closed"]));
    p.on("audio", (_pcm, item) => got.push(["audio", item]));
    await p.connect({ instructions: "", tools: [] });
    await p.connect({ instructions: "", tools: [] });
    srv.send(audioDelta()); // reaches the second socket only
    await until(() => got.length >= 1);
    await Bun.sleep(50);
    expect(got).toEqual([["audio", "a1"]]);
    expect(srv.frames.filter((f) => f.type === "session.start")).toHaveLength(2);
    await p.close();
  });

  it("close() sends session.close, waits for session.closed, flushes partial transcript, and does not fire closed", async () => {
    srv = fakeServer(ack);
    const p = new OpenAILive({ apiKey: "k", model: "m", url: srv.url, ...FAST, outputGapMs: 5000 });
    const got: any[] = [];
    p.on("closed", () => got.push("closed"));
    p.on("transcript", (t) => got.push(t.text));
    await p.connect({ instructions: "", tools: [] });
    srv.send({ type: "session.output_transcript.delta", event_id: "t1", delta: "bye now", start_ms: 0, end_ms: 10 });
    await Bun.sleep(30);
    await p.close();
    expect(srv.frames.map((f) => f.type)).toEqual(["session.start", "session.close"]);
    await Bun.sleep(50);
    expect(got).toEqual(["bye now"]);
  });

  it("close() is bounded when session.closed never arrives", async () => {
    srv = fakeServer((f, s) => { if (f.type === "session.start") ack(f, s); });
    const p = new OpenAILive({ apiKey: "k", model: "m", url: srv.url, ...FAST });
    await p.connect({ instructions: "", tools: [] });
    const t0 = Date.now();
    await p.close();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("close() during the handshake rejects the pending connect at once", async () => {
    srv = fakeServer(); // never acks session.start
    const p = new OpenAILive({ apiKey: "k", model: "m", url: srv.url, ...FAST });
    const c = p.connect({ instructions: "", tools: [] });
    await until(() => srv!.frames.length >= 1);
    const t0 = Date.now();
    await p.close();
    await expect(c).rejects.toThrow("closed by client");
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("OpenAILive synthetic turns under the Conductor's flow", () => {
  it("participant speech during output ends that output turn: later audio gets a new item id", async () => {
    srv = fakeServer(ack);
    const p = new OpenAILive({ apiKey: "k", model: "m", url: srv.url, ...FAST, outputGapMs: 5000 });
    const got: any[] = [];
    p.on("audio", (_pcm, item) => got.push(["audio", item]));
    p.on("speechStarted", () => got.push(["speechStarted"]));
    p.on("responseDone", () => got.push(["responseDone"]));
    await p.connect({ instructions: "", tools: [] });
    srv.send(audioDelta());
    await until(() => got.length >= 1);
    srv.send({ type: "session.input_transcript.delta", event_id: "t1", delta: "wait", start_ms: 0, end_ms: 100 });
    await until(() => got.length >= 3);
    srv.send(audioDelta());
    await until(() => got.length >= 4);
    // speechStarted first, so the Conductor's drain on responseDone sees the speaker.
    expect(got).toEqual([["audio", "a1"], ["speechStarted"], ["responseDone"], ["audio", "a2"]]);
    await p.close();
  });

  it("respond() during output starts a new item, so the Conductor's flushed item does not swallow the answer", async () => {
    srv = fakeServer(ack);
    const p = new OpenAILive({ apiKey: "k", model: "m", url: srv.url, ...FAST, outputGapMs: 5000 });
    const got: any[] = [];
    p.on("audio", (_pcm, item) => got.push(["audio", item]));
    p.on("responseDone", () => got.push(["responseDone"]));
    await p.connect({ instructions: "", tools: [] });
    srv.send(audioDelta());
    await until(() => got.length >= 1);
    p.addContext("Say this: update");
    p.respond();
    srv.send(audioDelta());
    await until(() => got.length >= 2);
    await Bun.sleep(30);
    // No responseDone inside respond(): the Conductor marks its own response active right after.
    expect(got).toEqual([["audio", "a1"], ["audio", "a2"]]);
    await p.close();
  });

  it("a respond() that produces no audio still ends with a responseDone", async () => {
    srv = fakeServer(ack);
    const p = new OpenAILive({ apiKey: "k", model: "m", url: srv.url, ...FAST, respondTimeoutMs: 60 });
    let dones = 0;
    p.on("responseDone", () => dones++);
    await p.connect({ instructions: "", tools: [] });
    p.respond();
    await until(() => dones === 1);
    await Bun.sleep(100);
    expect(dones).toBe(1);
    await p.close();
  });

  it("a respond() answered with audio does not fire a second, watchdog responseDone", async () => {
    srv = fakeServer(ack);
    const p = new OpenAILive({ apiKey: "k", model: "m", url: srv.url, ...FAST, respondTimeoutMs: 80 });
    let dones = 0;
    p.on("responseDone", () => dones++);
    await p.connect({ instructions: "", tools: [] });
    p.respond();
    srv.send(audioDelta());
    await until(() => dones === 1);
    await Bun.sleep(150);
    expect(dones).toBe(1);
    await p.close();
  });

  it("no event reaches listeners after close()", async () => {
    srv = fakeServer((f, s) => { if (f.type === "session.start") ack(f, s); }); // never answers session.close
    const p = new OpenAILive({ apiKey: "k", model: "m", url: srv.url, ...FAST });
    const got: string[] = [];
    for (const k of ["audio", "transcript", "speechStarted", "speechStopped", "responseDone", "toolCall", "error", "closed"] as const) {
      p.on(k, () => got.push(k));
    }
    await p.connect({ instructions: "", tools: [] });
    const closing = p.close();
    srv.send(audioDelta());
    srv.send({ type: "session.input_transcript.delta", event_id: "t1", delta: "hi", start_ms: 0, end_ms: 1 });
    srv.send({ type: "session.delegation.created", event_id: "d1", offset_ms: 0, delegation: { id: "del_1", type: "delegation", target: "client" } });
    await closing;
    srv.closeClient();
    await Bun.sleep(100);
    expect(got).toEqual([]);
  });
});

describe("OpenAILive with the real Conductor", () => {
  function wire(p: OpenAILive) {
    const audio = new FakeAudio();
    const emitted: ChildMsg[] = [];
    const c = new Conductor(
      { provider: p, audio, emit: (m) => emitted.push(m), end: () => {}, reconnect: () => {} },
      { outputRate: 24000, staleSeq: 6, maxMs: 3_600_000, startedAt: Date.now() },
    );
    p.on("audio", (pcm, item) => c.onAudio(pcm, item));
    p.on("transcript", (t) => c.onTranscript(t));
    p.on("speechStarted", () => void c.onSpeechStarted());
    p.on("speechStopped", () => c.onSpeechStopped());
    p.on("responseDone", () => c.onResponseDone());
    p.on("toolCall", (call) => c.onToolCall(call, Date.now()));
    return { c, audio, emitted };
  }
  const spoken = () => srv!.frames.filter((f) => f.type === "session.commentary.append");

  it("a next_gap steer waits for the synthetic responseDone, then is spoken", async () => {
    srv = fakeServer(ack);
    const p = new OpenAILive({ apiKey: "k", model: "m", url: srv.url, ...FAST });
    const { c, audio } = wire(p);
    await p.connect({ instructions: "", tools: [] });
    srv.send(audioDelta());
    await until(() => audio.written.length === 1);
    await c.say({ type: "say", text: "the build is green", when: "next_gap", asOf: c.seq });
    expect(spoken()).toHaveLength(0); // held while the agent talks
    await until(() => spoken().length === 1); // drained by the synthetic responseDone
    expect(spoken()[0].content).toContain("the build is green");
    await p.close();
  });

  it("after participant speech the steer waits for the auto-response window, then drains on tick", async () => {
    srv = fakeServer(ack);
    const p = new OpenAILive({ apiKey: "k", model: "m", url: srv.url, ...FAST });
    const { c, emitted } = wire(p);
    await p.connect({ instructions: "", tools: [] });
    const t0 = Date.now();
    c.tick(t0);
    srv.send({ type: "session.input_transcript.delta", event_id: "t1", delta: "any news", start_ms: 0, end_ms: 100 });
    await until(() => emitted.some((m) => m.type === "transcript")); // synthetic speechStopped has fired
    await c.say({ type: "say", text: "yes", when: "next_gap", asOf: c.seq });
    c.tick(t0 + 100);
    expect(spoken()).toHaveLength(0); // GPT-Live may still answer on its own
    c.tick(t0 + AUTO_RESPONSE_WAIT_MS + 1);
    await until(() => spoken().length === 1);
    await p.close();
  });

  it("a barge-in flushes queued audio, and the agent's next audio still plays", async () => {
    srv = fakeServer(ack);
    const p = new OpenAILive({ apiKey: "k", model: "m", url: srv.url, ...FAST, outputGapMs: 5000 });
    const { audio } = wire(p);
    await p.connect({ instructions: "", tools: [] });
    srv.send(audioDelta());
    await until(() => audio.written.length === 1);
    srv.send({ type: "session.input_transcript.delta", event_id: "t1", delta: "hold on", start_ms: 0, end_ms: 100 });
    await until(() => audio.clears === 1);
    srv.send(audioDelta());
    await until(() => audio.written.length === 2);
    await p.close();
  });

  it("say now during output flushes, speaks, and the spoken answer is not dropped as the flushed item", async () => {
    srv = fakeServer(ack);
    const p = new OpenAILive({ apiKey: "k", model: "m", url: srv.url, ...FAST, outputGapMs: 5000 });
    const { c, audio } = wire(p);
    await p.connect({ instructions: "", tools: [] });
    srv.send(audioDelta());
    await until(() => audio.written.length === 1);
    await c.say({ type: "say", text: "stop, the deploy failed", when: "now", asOf: c.seq });
    expect(audio.clears).toBe(1);
    await until(() => spoken().length === 1);
    srv.send(audioDelta()); // the commentary, spoken without a quiet gap
    await until(() => audio.written.length === 2);
    await p.close();
  });

  it("a client delegation reaches the Conductor as a delegate with the participant's words, transcript first", async () => {
    srv = fakeServer(ack);
    const p = new OpenAILive({ apiKey: "k", model: "m", url: srv.url, ...FAST, inputGapMs: 500 });
    const { emitted } = wire(p);
    await p.connect({ instructions: "", tools: [] });
    srv.send({ type: "session.input_transcript.delta", event_id: "t1", delta: "check the queue depth", start_ms: 0, end_ms: 100 });
    srv.send({ type: "session.delegation.created", event_id: "d1", offset_ms: 120, delegation: { id: "del_9", type: "delegation", target: "client" } });
    await until(() => emitted.some((m) => m.type === "delegate"));
    expect(emitted.map((m) => m.type)).toEqual(["transcript", "delegate"]);
    expect(emitted[1]).toMatchObject({ type: "delegate", id: "1", task: "check the queue depth", asOf: 1 });
    await until(() => srv!.frames.some((f) => f.type === "session.thinking.append" && f.delegation_id === "del_9"));
    await p.close();
  });
});

describe("createProvider openai-live", () => {
  it("builds the GPT-Live adapter", () => {
    expect(createProvider({ provider: "openai-live", model: "gpt-live-1", apiKey: "k" })).toBeInstanceOf(OpenAILive);
  });
});
