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
    srv.send({ type: "error", error: { type: "authentication_error", message: "no" } });
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
});
