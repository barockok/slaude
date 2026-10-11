import { describe, it, expect, afterEach } from "bun:test";
import { OpenAIRealtime } from "../../src/voice/provider/openai-realtime";
import { pcmToBase64 } from "../../src/voice/provider/types";
import { until } from "./fakes";

type Srv = { url: string; frames: any[]; send(obj: unknown): void; headers: Headers | null; stop(): void; closeClient(): void };
function fakeServer(onFrame?: (f: any, s: Srv) => void): Srv {
  let sock: any = null;
  const s: Srv = {
    url: "", frames: [], headers: null,
    send: (o) => sock?.send(JSON.stringify(o)),
    stop: () => server.stop(true),
    closeClient: () => sock?.close(1011, "bye"),
  };
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) { s.headers = req.headers; return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
    websocket: {
      open(ws) { sock = ws; },
      message(_ws, m) { const f = JSON.parse(String(m)); s.frames.push(f); onFrame?.(f, s); },
    },
  });
  s.url = `ws://localhost:${server.port}/v1/realtime`;
  return s;
}
const ack = (f: any, s: Srv) => { if (f.type === "session.update") s.send({ type: "session.updated" }); };

let srv: Srv | null = null;
afterEach(() => { void srv?.stop(); });

describe("OpenAIRealtime", () => {
  it("declares that a cancelled response still emits done", () => {
    const p = new OpenAIRealtime({ apiKey: "k", model: "m", url: "ws://unused" });
    expect(p.caps.cancelEmitsDone).toBe(true);
  });

  it("connects with bearer auth and sends session.update with tools and audio format", async () => {
    srv = fakeServer(ack);
    const p = new OpenAIRealtime({ apiKey: "sk-test", model: "gpt-realtime", url: srv.url });
    await p.connect({ instructions: "be brief", tools: [{ name: "delegate", description: "d", parameters: { type: "object" } }], voice: "marin" });
    expect(srv.headers!.get("authorization")).toBe("Bearer sk-test");
    const su = srv.frames.find((f) => f.type === "session.update");
    expect(su.session.instructions).toBe("be brief");
    expect(su.session.tools[0]).toMatchObject({ type: "function", name: "delegate" });
    expect(su.session.audio.output.voice).toBe("marin");
    expect(su.session.audio.input.turn_detection).toMatchObject({ type: "server_vad", interrupt_response: true });
    await p.close();
  });

  it("maps client methods to frames", async () => {
    srv = fakeServer(ack);
    const p = new OpenAIRealtime({ apiKey: "k", model: "m", url: srv.url });
    await p.connect({ instructions: "", tools: [] });
    p.sendAudio(new Int16Array([1, 2]));
    p.addContext("fact");
    p.respond();
    p.cancel();
    p.truncate("item_1", 1234);
    srv.send({ type: "response.done" }); // the cancelled response ends
    await Bun.sleep(30);
    p.toolResult("call_1", { id: "1", status: "working" });
    await until(() => srv!.frames.length >= 8);
    const types = srv.frames.map((f) => f.type);
    expect(types).toEqual(["session.update", "input_audio_buffer.append", "conversation.item.create", "response.create",
      "response.cancel", "conversation.item.truncate", "conversation.item.create", "response.create"]);
    expect(srv.frames[1].audio).toBe(pcmToBase64(new Int16Array([1, 2])));
    expect(srv.frames[2].item).toMatchObject({ type: "message", role: "system" });
    expect(srv.frames[5]).toMatchObject({ item_id: "item_1", content_index: 0, audio_end_ms: 1234 });
    expect(srv.frames[6].item).toMatchObject({ type: "function_call_output", call_id: "call_1", output: '{"id":"1","status":"working"}' });
    await p.close();
  });

  it("maps server events to slaude events", async () => {
    srv = fakeServer(ack);
    const p = new OpenAIRealtime({ apiKey: "k", model: "m", url: srv.url });
    const got: any[] = [];
    p.on("audio", (pcm, item) => got.push(["audio", pcm.length, item]));
    p.on("transcript", (t) => got.push(["transcript", t.role, t.text]));
    p.on("speechStarted", () => got.push(["speechStarted"]));
    p.on("speechStopped", () => got.push(["speechStopped"]));
    p.on("toolCall", (c) => got.push(["toolCall", c.callId, c.name, c.args]));
    p.on("responseDone", () => got.push(["responseDone"]));
    p.on("error", (e) => got.push(["error", e.fatal]));
    await p.connect({ instructions: "", tools: [] });
    srv.send({ type: "response.output_audio.delta", item_id: "i1", delta: pcmToBase64(new Int16Array(4)) });
    srv.send({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "hello" });
    srv.send({ type: "response.output_audio_transcript.done", item_id: "i1", transcript: "hi there" });
    srv.send({ type: "input_audio_buffer.speech_started" });
    srv.send({ type: "input_audio_buffer.speech_stopped" });
    srv.send({ type: "response.function_call_arguments.done", call_id: "c1", name: "delegate", arguments: '{"task":"x"}' });
    srv.send({ type: "response.done" });
    srv.send({ type: "error", error: { type: "invalid_request_error", message: "bad" } });
    await until(() => got.length >= 8);
    expect(got).toEqual([
      ["audio", 4, "i1"], ["transcript", "user", "hello"], ["transcript", "assistant", "hi there"],
      ["speechStarted"], ["speechStopped"], ["toolCall", "c1", "delegate", { task: "x" }], ["responseDone"], ["error", false],
    ]);
    await p.close();
  });

  it("treats auth errors as fatal and an unexpected close as non-fatal + closed", async () => {
    srv = fakeServer(ack);
    const p = new OpenAIRealtime({ apiKey: "k", model: "m", url: srv.url });
    const got: any[] = [];
    p.on("error", (e) => got.push(["error", e.fatal]));
    p.on("closed", () => got.push(["closed"]));
    await p.connect({ instructions: "", tools: [] });
    srv.send({ type: "error", error: { type: "invalid_request_error", code: "invalid_api_key", message: "no" } });
    srv.closeClient();
    await until(() => got.length >= 3);
    expect(got).toEqual([["error", true], ["error", false], ["closed"]]);
  });

  it("sends the seed as a system item after session.update", async () => {
    srv = fakeServer(ack);
    const p = new OpenAIRealtime({ apiKey: "k", model: "m", url: srv.url });
    await p.connect({ instructions: "", tools: [], seed: "earlier: user asked X" });
    await until(() => srv!.frames.length >= 2);
    expect(srv.frames[1].item.content[0].text).toContain("earlier: user asked X");
    await p.close();
  });

  it("a tool result inside the function call's own response defers response.create until that response is done", async () => {
    srv = fakeServer(ack);
    const p = new OpenAIRealtime({ apiKey: "k", model: "m", url: srv.url });
    const calls: string[] = [];
    p.on("toolCall", (c) => { calls.push(c.callId); p.toolResult(c.callId, { id: "1", status: "working" }); });
    await p.connect({ instructions: "", tools: [] });
    srv.send({ type: "response.created", response: { id: "r1" } });
    srv.send({ type: "response.function_call_arguments.done", call_id: "c1", name: "delegate", arguments: "{}" });
    srv.send({ type: "response.function_call_arguments.done", call_id: "c2", name: "delegate", arguments: "{}" });
    await until(() => srv!.frames.filter((f) => f.type === "conversation.item.create").length === 2);
    await Bun.sleep(30);
    expect(srv.frames.filter((f) => f.type === "response.create")).toHaveLength(0); // r1 still active
    srv.send({ type: "response.done", response: { id: "r1" } });
    await until(() => srv!.frames.some((f) => f.type === "response.create"));
    await Bun.sleep(30);
    expect(srv.frames.filter((f) => f.type === "response.create")).toHaveLength(1); // one create for both results
    await p.close();
  });

  it("a respond() while a response is active waits for its done, and coalesces with a pending tool result", async () => {
    srv = fakeServer(ack);
    const p = new OpenAIRealtime({ apiKey: "k", model: "m", url: srv.url });
    await p.connect({ instructions: "", tools: [] });
    srv.send({ type: "response.created", response: { id: "r1" } });
    srv.send({ type: "response.function_call_arguments.done", call_id: "c1", name: "delegate", arguments: "{}" });
    await Bun.sleep(30);
    p.toolResult("c1", { ok: true });
    p.respond();
    await Bun.sleep(30);
    expect(srv.frames.filter((f) => f.type === "response.create")).toHaveLength(0);
    srv.send({ type: "response.done", response: { id: "r1" } });
    await until(() => srv!.frames.some((f) => f.type === "response.create"));
    p.respond(); // our own create is in flight: still one active response
    await Bun.sleep(30);
    expect(srv.frames.filter((f) => f.type === "response.create")).toHaveLength(1);
    await p.close();
  });

  it("a steer drained on response.done shares the held create: one response, after the steer's context", async () => {
    srv = fakeServer(ack);
    const p = new OpenAIRealtime({ apiKey: "k", model: "m", url: srv.url });
    p.on("toolCall", (c) => p.toolResult(c.callId, { ok: true }));
    p.on("responseDone", () => { p.addContext("steer text"); p.respond(); }); // what the Conductor's drain does
    await p.connect({ instructions: "", tools: [] });
    srv.send({ type: "response.created", response: { id: "r1" } });
    srv.send({ type: "response.function_call_arguments.done", call_id: "c1", name: "delegate", arguments: "{}" });
    await until(() => srv!.frames.some((f) => f.item?.type === "function_call_output"));
    srv.send({ type: "response.done", response: { id: "r1" } });
    await until(() => srv!.frames.some((f) => f.type === "response.create"));
    await Bun.sleep(30);
    const types = srv.frames.map((f) => f.item?.type ?? f.type).slice(1);
    expect(types).toEqual(["function_call_output", "message", "response.create"]);
    await p.close();
  });

  it("a create rejected because a response is already active is re-sent at that response's done", async () => {
    srv = fakeServer(ack);
    const p = new OpenAIRealtime({ apiKey: "k", model: "m", url: srv.url });
    await p.connect({ instructions: "", tools: [] });
    p.respond();
    await until(() => srv!.frames.some((f) => f.type === "response.create"));
    const create = srv.frames.find((f) => f.type === "response.create");
    expect(typeof create.event_id).toBe("string");
    srv.send({ type: "error", error: { type: "invalid_request_error", code: "conversation_already_has_active_response", message: "busy", event_id: create.event_id } });
    await Bun.sleep(30);
    srv.send({ type: "response.done", response: { id: "r_server" } });
    await until(() => srv!.frames.filter((f) => f.type === "response.create").length === 2);
    await p.close();
  });

  it("any other rejected create clears the active flag and re-arms it for the next done", async () => {
    srv = fakeServer(ack);
    const p = new OpenAIRealtime({ apiKey: "k", model: "m", url: srv.url });
    await p.connect({ instructions: "", tools: [] });
    p.respond();
    await until(() => srv!.frames.some((f) => f.type === "response.create"));
    const create = srv.frames.find((f) => f.type === "response.create");
    srv.send({ type: "error", error: { type: "server_error", code: null, message: "oops", event_id: create.event_id } });
    await Bun.sleep(30);
    srv.send({ type: "response.done", response: { id: "r_vad" } });
    await until(() => srv!.frames.filter((f) => f.type === "response.create").length === 2);
    // Not latched: after that create's own done, a new respond() goes straight out.
    srv.send({ type: "response.done", response: { id: "r2" } });
    await Bun.sleep(30);
    p.respond();
    await until(() => srv!.frames.filter((f) => f.type === "response.create").length === 3);
    await p.close();
  });

  it("an unrelated error does not touch the create state", async () => {
    srv = fakeServer(ack);
    const p = new OpenAIRealtime({ apiKey: "k", model: "m", url: srv.url });
    await p.connect({ instructions: "", tools: [] });
    p.respond();
    await until(() => srv!.frames.some((f) => f.type === "response.create"));
    srv.send({ type: "error", error: { type: "invalid_request_error", code: "x", message: "bad item", event_id: "someone_else" } });
    await Bun.sleep(30);
    p.respond(); // ours is still active: held
    await Bun.sleep(30);
    expect(srv.frames.filter((f) => f.type === "response.create")).toHaveLength(1);
    await p.close();
  });

  it("a failed connect closes its socket and a stale close does not fire closed", async () => {
    srv = fakeServer((f, s) => { if (f.type === "session.update") s.send({ type: "error", error: { type: "invalid_request_error", code: "invalid_api_key", message: "bad key" } }); });
    const p = new OpenAIRealtime({ apiKey: "k", model: "m", url: srv.url });
    const got: any[] = [];
    p.on("error", (e) => got.push(["error", e.fatal]));
    p.on("closed", () => got.push(["closed"]));
    await expect(p.connect({ instructions: "", tools: [] })).rejects.toThrow("bad key");
    srv.closeClient();
    await Bun.sleep(100);
    expect(got).toEqual([["error", true]]);
  });
});
