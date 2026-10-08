/**
 * OpenAI Realtime over WebSocket (server-to-server). Event names are pinned
 * here and in tests/voice/openai-realtime.test.ts only. Server VAD with
 * interrupt_response: the provider decides and cancels interruptions itself;
 * flushing audio already handed to workbench is the Conductor's job (spec §5.4).
 */
import {
  TypedEmitter, base64ToPcm, pcmToBase64, seedText,
  type ProviderConnect, type ProviderEvents, type VoiceProvider, type VoiceProviderCaps,
} from "./types";

// Documented error.type values are invalid_request_error / server_error; auth and
// quota failures arrive as error.code. The type names are matched too, on either field.
const FATAL_ERRORS = new Set(["authentication_error", "permission_error", "invalid_api_key", "insufficient_quota"]);
const isFatal = (e: any): boolean => FATAL_ERRORS.has(e?.code) || FATAL_ERRORS.has(e?.type);

export class OpenAIRealtime extends TypedEmitter<ProviderEvents> implements VoiceProvider {
  readonly caps: VoiceProviderCaps = { inputRate: 24000, outputRate: 24000, truncate: true, maxSessionSec: 3600, cancelEmitsDone: true };
  #ws: WebSocket | null = null;
  #closing = false;
  constructor(private o: { apiKey: string; model: string; url?: string; transcribeModel?: string }) {
    super();
  }

  async connect(init: ProviderConnect): Promise<void> {
    const u = new URL(this.o.url ?? "wss://api.openai.com/v1/realtime");
    u.searchParams.set("model", this.o.model);
    // Bun's WebSocket accepts request headers as a second-argument option.
    const ws = new WebSocket(u.toString(), { headers: { Authorization: `Bearer ${this.o.apiKey}` } } as any);
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
      const timer = setTimeout(() => fail("realtime connect timeout", false), 10_000);
      ws.onopen = () => {
        this.#send({
          type: "session.update",
          session: {
            type: "realtime",
            instructions: init.instructions,
            tools: init.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters })),
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24000 },
                transcription: { model: this.o.transcribeModel ?? "gpt-4o-mini-transcribe" },
                turn_detection: { type: "server_vad", interrupt_response: true, create_response: true },
              },
              output: { format: { type: "audio/pcm", rate: 24000 }, ...(init.voice ? { voice: init.voice } : {}) },
            },
          },
        });
      };
      ws.onmessage = (ev) => {
        if (ws !== this.#ws) return;
        let m: any;
        try { m = JSON.parse(String(ev.data)); } catch { return; }
        if (!ready && m?.type === "error" && isFatal(m.error)) {
          return fail(String(m.error?.message ?? "realtime error"), true);
        }
        if (!ready && m?.type === "session.updated") {
          ready = true;
          settled = true;
          clearTimeout(timer);
          if (init.seed) this.addContext(seedText(init.seed));
          resolve();
        }
        this.#onServer(m);
      };
      // A refused upgrade (e.g. a bad key) surfaces here before session.updated: fatal.
      ws.onerror = () => {
        if (ws !== this.#ws) return;
        if (!ready) fail("realtime websocket error during handshake", true);
      };
      ws.onclose = () => {
        if (ws !== this.#ws) return;
        if (!ready) return fail("realtime connection closed during handshake", true);
        if (!this.#closing) {
          this.fire("error", { fatal: false, message: "realtime connection closed" });
          this.fire("closed");
        }
      };
    });
  }

  #onServer(m: any): void {
    switch (m.type) {
      case "response.output_audio.delta":
        this.fire("audio", base64ToPcm(m.delta), m.item_id);
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (m.transcript?.trim()) this.fire("transcript", { role: "user", text: m.transcript.trim(), itemId: m.item_id });
        break;
      case "response.output_audio_transcript.done":
        if (m.transcript?.trim()) this.fire("transcript", { role: "assistant", text: m.transcript.trim(), itemId: m.item_id });
        break;
      case "input_audio_buffer.speech_started":
        this.fire("speechStarted");
        break;
      case "input_audio_buffer.speech_stopped":
        this.fire("speechStopped");
        break;
      case "response.function_call_arguments.done": {
        let args: unknown = {};
        try { args = JSON.parse(m.arguments || "{}"); } catch { args = {}; }
        this.fire("toolCall", { callId: m.call_id, name: m.name, args });
        break;
      }
      case "response.done":
        this.fire("responseDone");
        break;
      case "error":
        this.fire("error", { fatal: isFatal(m.error), message: String(m.error?.message ?? "error") });
        break;
    }
  }

  #send(o: unknown): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(o));
  }
  sendAudio(pcm: Int16Array): void { this.#send({ type: "input_audio_buffer.append", audio: pcmToBase64(pcm) }); }
  addContext(text: string): void {
    this.#send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text }] } });
  }
  respond(): void { this.#send({ type: "response.create" }); }
  cancel(): void { this.#send({ type: "response.cancel" }); }
  truncate(itemId: string, ms: number): void {
    this.#send({ type: "conversation.item.truncate", item_id: itemId, content_index: 0, audio_end_ms: Math.max(0, Math.round(ms)) });
  }
  toolResult(callId: string, output: unknown): void {
    this.#send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) } });
    this.#send({ type: "response.create" });
  }
  async close(): Promise<void> {
    this.#closing = true;
    try { this.#ws?.close(1000, "done"); } catch {}
    this.#ws = null;
  }
}
