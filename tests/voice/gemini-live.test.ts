import { describe, it, expect, afterEach } from "bun:test";
import { GeminiLive } from "../../src/voice/provider/gemini-live";
import { createProvider } from "../../src/voice/provider";
import { OpenAIRealtime } from "../../src/voice/provider/openai-realtime";
import { pcmToBase64 } from "../../src/voice/provider/types";
import { until } from "./fakes";

function fakeServer(opts: { ack?: boolean; closeOnSetup?: number } = {}) {
  const ack = opts.ack ?? true;
  let sock: any = null;
  const s: any = { frames: [] as any[], url: "", query: "" };
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) { s.query = new URL(req.url).search; return srv.upgrade(req) ? undefined : new Response("", { status: 400 }); },
    websocket: {
      open(ws) { sock = ws; },
      message(ws, m) {
        const f = JSON.parse(String(m)); s.frames.push(f);
        if (f.setup && opts.closeOnSetup) ws.close(opts.closeOnSetup, "nope");
        else if (f.setup && ack) sock.send(new TextEncoder().encode(JSON.stringify({ setupComplete: {} }))); // binary frame
      },
    },
  });
  s.url = `ws://localhost:${server.port}/live`;
  s.send = (o: unknown) => sock.send(JSON.stringify(o));
  s.stop = () => server.stop(true);
  return s;
}
let srv: any = null;
afterEach(() => { void srv?.stop(); });

describe("GeminiLive", () => {
  it("sends setup with key, tools, transcription and voice", async () => {
    srv = fakeServer();
    const p = new GeminiLive({ apiKey: "gk", model: "gemini-live-x", url: srv.url });
    await p.connect({ instructions: "be brief", tools: [{ name: "delegate", description: "d", parameters: { type: "object" } }], voice: "Puck" });
    expect(srv.query).toContain("key=gk");
    const setup = srv.frames[0].setup;
    expect(setup.model).toBe("models/gemini-live-x");
    expect(setup.systemInstruction.parts[0].text).toBe("be brief");
    expect(setup.tools[0].functionDeclarations[0].name).toBe("delegate");
    expect(setup.inputAudioTranscription).toEqual({});
    expect(setup.outputAudioTranscription).toEqual({});
    expect(setup.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Puck");
    expect(p.caps.truncate).toBe(false);
    expect(p.caps.maxSessionSec).toBe(540);
    await p.close();
  });

  it("maps methods and events; accumulates transcription chunks until turnComplete", async () => {
    srv = fakeServer();
    const p = new GeminiLive({ apiKey: "gk", model: "m", url: srv.url });
    const got: any[] = [];
    p.on("audio", (pcm, item) => got.push(["audio", pcm.length, item]));
    p.on("transcript", (t) => got.push(["transcript", t.role, t.text]));
    p.on("speechStarted", () => got.push(["speechStarted"]));
    p.on("toolCall", (c) => got.push(["toolCall", c.callId, c.name, c.args]));
    p.on("responseDone", () => got.push(["responseDone"]));
    await p.connect({ instructions: "", tools: [] });
    p.sendAudio(new Int16Array(2));
    p.addContext("fact");
    p.respond();
    p.cancel(); // no-op: Gemini interrupts server-side
    srv.send({ toolCall: { functionCalls: [{ id: "fc1", name: "delegate", args: {} }] } });
    await until(() => got.length >= 1);
    p.toolResult("fc1", { ok: true });
    await until(() => srv.frames.length >= 5);
    expect(srv.frames.length).toBe(5);
    expect(srv.frames[1].realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000");
    expect(srv.frames[2].clientContent).toMatchObject({ turnComplete: false });
    expect(srv.frames[3].clientContent).toMatchObject({ turnComplete: true });
    expect(srv.frames[4].toolResponse.functionResponses[0]).toMatchObject({ id: "fc1", name: "delegate", response: { ok: true } });
    got.length = 0;

    srv.send({ serverContent: { inputTranscription: { text: "hel" } } });
    srv.send({ serverContent: { inputTranscription: { text: "lo" } } });
    srv.send({ serverContent: { modelTurn: { parts: [{ inlineData: { data: pcmToBase64(new Int16Array(6)) } }] }, outputTranscription: { text: "hi" } } });
    srv.send({ serverContent: { turnComplete: true } });
    srv.send({ serverContent: { interrupted: true } });
    srv.send({ toolCall: { functionCalls: [{ id: "fc2", name: "delegate", args: { task: "t" } }] } });
    await until(() => got.length >= 6);
    expect(got).toEqual([
      ["transcript", "user", "hello"], ["audio", 6, "g1"], ["transcript", "assistant", "hi"], ["responseDone"],
      ["speechStarted"], ["toolCall", "fc2", "delegate", { task: "t" }],
    ]);
    await p.close();
  });

  it("emits speechStopped after a barge-in, at the next model audio", async () => {
    srv = fakeServer();
    const p = new GeminiLive({ apiKey: "k", model: "m", url: srv.url });
    const got: string[] = [];
    p.on("speechStarted", () => got.push("started"));
    p.on("speechStopped", () => got.push("stopped"));
    p.on("audio", () => got.push("audio"));
    await p.connect({ instructions: "", tools: [] });
    srv.send({ serverContent: { interrupted: true } });
    await until(() => got.length >= 1);
    srv.send({ serverContent: { modelTurn: { parts: [{ inlineData: { data: pcmToBase64(new Int16Array(2)) } }] } } });
    srv.send({ serverContent: { turnComplete: true } });
    await until(() => got.length >= 3);
    await Bun.sleep(20);
    expect(got).toEqual(["started", "stopped", "audio"]);
    // Barge-in with no further audio: stopped at turnComplete.
    got.length = 0;
    srv.send({ serverContent: { interrupted: true } });
    srv.send({ serverContent: { turnComplete: true } });
    await until(() => got.length >= 2);
    expect(got).toEqual(["started", "stopped"]);
    await p.close();
  });

  it("holds addContext while the model speaks; its own interrupt is not a barge-in", async () => {
    srv = fakeServer();
    const p = new GeminiLive({ apiKey: "k", model: "m", url: srv.url });
    const got: string[] = [];
    p.on("speechStarted", () => got.push("started"));
    p.on("responseDone", () => got.push("done"));
    p.on("audio", () => got.push("audio"));
    await p.connect({ instructions: "", tools: [] });
    const audio = { serverContent: { modelTurn: { parts: [{ inlineData: { data: pcmToBase64(new Int16Array(2)) } }] } } };
    srv.send(audio);
    await until(() => got.length >= 1);
    p.addContext("later");
    await Bun.sleep(40);
    expect(srv.frames.length).toBe(1);
    srv.send({ serverContent: { turnComplete: true } });
    await until(() => srv.frames.length >= 2);
    expect(srv.frames[1].clientContent.turns[0].parts[0].text).toContain("later");

    srv.send(audio);
    await until(() => got.filter((g) => g === "audio").length >= 2);
    p.addContext("queued");
    p.respond();
    await until(() => srv.frames.length >= 4);
    expect(srv.frames[2].clientContent).toMatchObject({ turnComplete: false });
    expect(srv.frames[3].clientContent).toMatchObject({ turnComplete: true });
    srv.send({ serverContent: { interrupted: true } });
    await Bun.sleep(40);
    expect(got.includes("started")).toBe(false);
    await p.close();
  });

  it("rejects a connect refused with a policy close (fatal) and leaves no live socket", async () => {
    srv = fakeServer({ closeOnSetup: 1008 });
    const p = new GeminiLive({ apiKey: "bad", model: "m", url: srv.url });
    const errs: any[] = [];
    p.on("error", (e) => errs.push(e));
    await expect(p.connect({ instructions: "", tools: [] })).rejects.toThrow();
    expect(errs[0]).toMatchObject({ fatal: true });
    p.sendAudio(new Int16Array(1)); // must not throw
  });

  it("restores a seed after setupComplete and ignores malformed frames", async () => {
    srv = fakeServer();
    const p = new GeminiLive({ apiKey: "k", model: "m", url: srv.url });
    await p.connect({ instructions: "", tools: [], seed: "user: hi" });
    await until(() => srv.frames.length >= 2);
    expect(srv.frames[1].clientContent.turns[0].parts[0].text).toContain("user: hi");
    srv.send("not json{");
    await Bun.sleep(30);
    await p.close();
  });
});

describe("createProvider", () => {
  it("picks the adapter by provider id", () => {
    expect(createProvider({ provider: "openai", model: "m", apiKey: "k" })).toBeInstanceOf(OpenAIRealtime);
    expect(createProvider({ provider: "gemini", model: "m", apiKey: "k" })).toBeInstanceOf(GeminiLive);
  });
});
