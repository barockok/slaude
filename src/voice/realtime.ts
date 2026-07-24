// OpenAI Realtime API WebSocket client.
// Auth: POST /v1/realtime/client_secrets → ephemeral token → WS connect.
// Audio format: PCM16 mono 24kHz in both directions, base64-encoded over WS.
//
// Events emitted:
//   "audio"     (Buffer)    — decoded PCM chunk from the model's response
//   "barge-in"              — speech detected; caller should cancel playback
//   "tool-call" (ToolCall)  — model wants to invoke a tool
//   "error"     (Error)
//   "close"     (code: number)

import { EventEmitter } from "node:events";

export const REALTIME_SAMPLE_RATE = 24000;

export interface RealtimeTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface RealtimeOptions {
  apiKey: string;
  model?: string;
  voice?: string;
  instructions?: string;
  tools?: RealtimeTool[];
}

export interface ToolCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

export class RealtimeClient extends EventEmitter {
  private opts: RealtimeOptions;
  private ws: WebSocket | null = null;
  private responseActive = false;
  // keyed by call_id; name captured from output_item.added, args from args.delta
  private pendingToolCalls = new Map<string, { name: string; argsRaw: string }>();

  constructor(opts: RealtimeOptions) {
    super();
    this.opts = opts;
  }

  connect(): void {
    void this._connect();
  }

  private async _connect(): Promise<void> {
    // Fetch ephemeral token via the GA client_secrets endpoint.
    // The session is fully pre-configured here; no session.update needed on the WS.
    const sessionBody = {
      session: {
        type: "realtime",
        instructions: this.opts.instructions ?? "",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: REALTIME_SAMPLE_RATE },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
              idle_timeout_ms: null,
            },
          },
          output: {
            format: { type: "audio/pcm", rate: REALTIME_SAMPLE_RATE },
            voice: this.opts.voice ?? "shimmer",
          },
        },
        output_modalities: ["audio"],
        tools: (this.opts.tools ?? []).map((t) => ({
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
        max_output_tokens: "inf",
      },
    };

    let ephemeralKey: string;
    try {
      const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(sessionBody),
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => res.statusText);
        this.emit("error", new Error(`client_secrets ${res.status}: ${msg}`));
        return;
      }
      const data = await res.json() as { value: string };
      ephemeralKey = data.value;
    } catch (e) {
      this.emit("error", new Error(`client_secrets fetch failed: ${String(e)}`));
      return;
    }

    const model = this.opts.model ?? "gpt-realtime-1.5";
    const wsUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${ephemeralKey}` } } as any);
    this.ws = ws;

    ws.addEventListener("message", (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      this.handle(msg);
    });

    ws.addEventListener("error", (ev) => {
      this.emit("error", new Error((ev as ErrorEvent).message ?? "ws error"));
    });

    ws.addEventListener("close", (ev) => {
      this.emit("close", (ev as CloseEvent).code);
    });
  }

  /** Feed raw PCM16 24kHz mono captured from the call. */
  sendAudio(pcm: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.send({ type: "input_audio_buffer.append", audio: pcm.toString("base64") });
  }

  /** Return a tool result and trigger the next model response. */
  submitToolResult(callId: string, output: string): void {
    this.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output },
    });
    this.send({ type: "response.create" });
  }

  /** Barge-in: cancel the active response (no-op if none active). */
  cancel(): void {
    if (this.responseActive) this.send({ type: "response.cancel" });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  private send(obj: unknown): void {
    try {
      this.ws?.send(JSON.stringify(obj));
    } catch {
      // swallow EPIPE equivalents
    }
  }

  /** Dispatch a parsed server event. Exposed for testing. */
  handle(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case "input_audio_buffer.speech_started":
        this.emit("barge-in");
        break;

      case "response.output_item.added": {
        // capture function call name before args stream in
        const item = msg.item as { type?: string; call_id?: string; name?: string } | undefined;
        if (item?.type === "function_call" && item.call_id && item.name) {
          this.pendingToolCalls.set(item.call_id, { name: item.name, argsRaw: "" });
        }
        break;
      }

      case "response.function_call_arguments.delta": {
        const callId = msg.call_id as string | undefined;
        const delta = (msg.delta as string | undefined) ?? "";
        const pending = callId ? this.pendingToolCalls.get(callId) : undefined;
        if (pending) pending.argsRaw += delta;
        break;
      }

      case "response.function_call_arguments.done": {
        const callId = msg.call_id as string | undefined;
        if (!callId) break;
        const argsStr = (msg.arguments as string | undefined) ?? "{}";
        const pending = this.pendingToolCalls.get(callId);
        if (!pending) break;
        this.pendingToolCalls.delete(callId);
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(argsStr);
        } catch {
          // leave args empty
        }
        this.emit("tool-call", { callId, name: pending.name, args } as ToolCall);
        break;
      }

      case "response.output_audio.delta":
      case "response.audio.delta": {
        const delta = msg.delta as string | undefined;
        if (delta) this.emit("audio", Buffer.from(delta, "base64"));
        break;
      }

      case "session.created":
        this.emit("ready");
        break;

      case "response.created":
        this.responseActive = true;
        break;

      case "response.done":
        this.responseActive = false;
        break;

      case "error": {
        const err = msg.error as { message?: string } | undefined;
        this.emit("error", new Error(err?.message ?? "realtime error"));
        break;
      }
    }
  }

  /** Inject a user text turn and trigger a response (for testing / greetings). */
  sendText(text: string): void {
    this.send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    });
    this.send({ type: "response.create" });
  }
}
