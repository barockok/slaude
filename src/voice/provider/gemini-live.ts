/**
 * Gemini Live (BidiGenerateContent) over WebSocket. No item truncation: the
 * server handles interruption itself (`interrupted`), so caps.truncate=false,
 * cancel() is a no-op, and the Conductor only flushes workbench audio. Gemini
 * has no item ids; one is synthesized per model turn. Transcription arrives in
 * chunks and is emitted whole when the side's turn ends.
 */
import {
  TypedEmitter, base64ToPcm, pcmToBase64, seedText,
  type ProviderConnect, type ProviderEvents, type VoiceProvider, type VoiceProviderCaps,
} from "./types";

export class GeminiLive extends TypedEmitter<ProviderEvents> implements VoiceProvider {
  readonly caps: VoiceProviderCaps = { inputRate: 16000, outputRate: 24000, truncate: false, maxSessionSec: 540 };
  #ws: WebSocket | null = null;
  #closing = false;
  #turn = 0;
  #inTurn = false;
  #userText = "";
  #modelText = "";
  #callNames = new Map<string, string>();
  /** Context queued while the model speaks: a clientContent message would interrupt it. */
  #pendingContext: string[] = [];
  /** We sent a completed clientContent mid-turn; the server's `interrupted` is ours, not the user's. */
  #selfInterrupt = false;
  /** A user barge-in was reported; speechStopped is owed once the user's turn ends. */
  #userSpeaking = false;
  constructor(private o: { apiKey: string; model: string; url?: string }) {
    super();
  }

  async connect(init: ProviderConnect): Promise<void> {
    // A reconnect must not leave the previous socket live.
    const prev = this.#ws;
    if (prev) {
      this.#ws = null;
      prev.onopen = prev.onmessage = prev.onerror = prev.onclose = null;
      try { prev.close(1000, "reconnect"); } catch {}
    }
    this.#turn = 0;
    this.#inTurn = false;
    this.#userText = this.#modelText = "";
    this.#callNames.clear();
    this.#pendingContext = [];
    this.#selfInterrupt = this.#userSpeaking = false;
    const base = this.o.url ??
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
    const ws = new WebSocket(`${base}?key=${encodeURIComponent(this.o.apiKey)}`);
    ws.binaryType = "arraybuffer";
    this.#ws = ws;
    this.#closing = false;
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      let settled = false;
      // Every failed-handshake path: detach, close the socket, reject once.
      const fail = (message: string, fatal: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        if (this.#ws === ws) this.#ws = null;
        try { ws.close(1000, "connect failed"); } catch {}
        if (fatal) this.fire("error", { fatal: true, message });
        reject(new Error(message));
      };
      const timer = setTimeout(() => fail("live connect timeout", false), 10_000);
      ws.onopen = () => {
        this.#send({
          setup: {
            model: `models/${this.o.model}`,
            generationConfig: {
              responseModalities: ["AUDIO"],
              ...(init.voice ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: init.voice } } } } : {}),
            },
            systemInstruction: { parts: [{ text: init.instructions }] },
            tools: init.tools.length
              ? [{ functionDeclarations: init.tools.map((x) => ({ name: x.name, description: x.description, parameters: x.parameters })) }]
              : [],
            inputAudioTranscription: {},
            outputAudioTranscription: {},
          },
        });
      };
      ws.onmessage = (ev) => {
        if (ws !== this.#ws) return;
        let m: any;
        try {
          m = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
        } catch { return; }
        if (!m || typeof m !== "object") return;
        if (!ready && m.setupComplete) {
          ready = true;
          settled = true;
          clearTimeout(timer);
          if (init.seed) this.addContext(seedText(init.seed));
          resolve();
          return;
        }
        this.#onServer(m);
      };
      // A refused upgrade (e.g. a bad key) surfaces before setupComplete: fatal.
      ws.onerror = () => {
        if (ws !== this.#ws) return;
        if (!ready) fail("live websocket error during handshake", true);
      };
      ws.onclose = (ev) => {
        if (ws !== this.#ws) return;
        // 1008 = policy (bad key / permission): not worth retrying.
        if (!ready) return fail(`live connection closed during handshake (${ev.code})`, true);
        if (!this.#closing) {
          this.fire("error", { fatal: ev.code === 1008, message: `live connection closed (${ev.code})` });
          this.fire("closed");
        }
      };
    });
  }

  #onServer(m: any): void {
    const sc = m.serverContent;
    if (sc) {
      if (sc.inputTranscription?.text) this.#userText += sc.inputTranscription.text;
      for (const part of sc.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) {
          if (!this.#inTurn) {
            this.#inTurn = true;
            this.#turn++;
            this.#flushUser();
            this.#endUserSpeech();
          }
          this.fire("audio", base64ToPcm(part.inlineData.data), `g${this.#turn}`);
        }
      }
      if (sc.outputTranscription?.text) this.#modelText += sc.outputTranscription.text;
      if (sc.interrupted) {
        this.#endModelTurn(false);
        if (this.#selfInterrupt) this.#selfInterrupt = false;
        else {
          this.#userSpeaking = true;
          this.fire("speechStarted");
        }
      }
      if (sc.turnComplete) {
        this.#selfInterrupt = false;
        this.#endUserSpeech();
        this.#endModelTurn(true);
        this.#flushContext();
      }
    }
    for (const fc of m.toolCall?.functionCalls ?? []) {
      this.#callNames.set(fc.id, fc.name);
      this.fire("toolCall", { callId: fc.id, name: fc.name, args: fc.args ?? {} });
    }
  }
  #endUserSpeech(): void {
    if (!this.#userSpeaking) return;
    this.#userSpeaking = false;
    this.fire("speechStopped");
  }
  #flushContext(): void {
    for (const text of this.#pendingContext.splice(0)) this.#sendContext(text);
  }
  #sendContext(text: string): void {
    this.#send({ clientContent: { turns: [{ role: "user", parts: [{ text: `[context] ${text}` }] }], turnComplete: false } });
  }
  #flushUser(): void {
    const t = this.#userText.trim();
    this.#userText = "";
    if (t) this.fire("transcript", { role: "user", text: t, itemId: `u${this.#turn}` });
  }
  #endModelTurn(done: boolean): void {
    this.#flushUser();
    const t = this.#modelText.trim();
    this.#modelText = "";
    if (t) this.fire("transcript", { role: "assistant", text: t, itemId: `g${this.#turn}` });
    this.#inTurn = false;
    if (done) this.fire("responseDone");
  }

  #send(o: unknown): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(o));
  }
  sendAudio(pcm: Int16Array): void {
    this.#send({ realtimeInput: { audio: { data: pcmToBase64(pcm), mimeType: "audio/pcm;rate=16000" } } });
  }
  addContext(text: string): void {
    if (this.#inTurn) this.#pendingContext.push(text);
    else this.#sendContext(text);
  }
  respond(): void {
    this.#flushContext();
    // Sending mid-turn interrupts the model by design; swallow the resulting `interrupted`.
    if (this.#inTurn) this.#selfInterrupt = true;
    this.#send({ clientContent: { turns: [], turnComplete: true } });
  }
  cancel(): void {
    /* No explicit cancel on Gemini Live: the server interrupts on user speech (spec §5.1). */
  }
  truncate(): void {
    /* caps.truncate=false — never called by the Conductor */
  }
  toolResult(callId: string, output: unknown): void {
    const name = this.#callNames.get(callId);
    this.#callNames.delete(callId);
    this.#send({ toolResponse: { functionResponses: [{ id: callId, ...(name ? { name } : {}), response: output }] } });
  }
  async close(): Promise<void> {
    this.#closing = true;
    try { this.#ws?.close(1000, "done"); } catch {}
    this.#ws = null;
  }
}
