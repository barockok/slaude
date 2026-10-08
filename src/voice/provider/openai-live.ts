/**
 * OpenAI GPT-Live over the primary WebSocket (server-to-server), client
 * delegation. Event names are pinned here and in tests/voice/openai-live.test.ts
 * only.
 *
 * GPT-Live is full duplex and calls no tools itself. When it needs the brain it
 * emits session.delegation.created (metadata only, no task text); slaude maps
 * that to the `delegate` tool call, builds the task from the participant
 * transcript, and answers through the session.*.append events. The protocol
 * has no item ids, turn boundaries, speech-start/stop or response-done events,
 * so this adapter synthesizes them from quiet gaps in the output audio and in
 * the input transcript. It cannot truncate (caps.truncate = false) and has no
 * response cancel: GPT-Live yields to the speaker on its own.
 *
 * Item ids follow the Conductor's model of a response: participant speech and
 * respond() each end the open output turn, so audio after a barge-in or a
 * spoken steer gets a new id and is not dropped as the Conductor's flushed item.
 */
import {
  TypedEmitter, base64ToPcm, pcmToBase64, seedText,
  type ProviderConnect, type ProviderEvents, type ToolSpec, type VoiceProvider, type VoiceProviderCaps,
} from "./types";

// error.type is a category (invalid_request_error, ...); auth and quota failures
// arrive as error.code. The type names are matched too, on either field.
const FATAL_ERRORS = new Set(["authentication_error", "permission_error", "invalid_api_key", "insufficient_quota"]);
const isFatal = (e: any): boolean => FATAL_ERRORS.has(e?.code) || FATAL_ERRORS.has(e?.type);

/** The slaude tool every GPT-Live client delegation maps to (Conductor's VOICE_TOOLS). */
export const DELEGATE_TOOL = "delegate";
const START_EVENT_ID = "slaude_session_start";
const APPEND_MAX_CHARS = 1800; // append content is capped at 500 tokens
const SEED_MAX_CHARS = 24_000; // session.input is capped at 8,192 tokens
const TASK_MAX_CHARS = 1000;
const HISTORY_LINES = 20;
const MIN_EXPIRY_SEC = 120; // below this a planned reconnect would loop
const RESPOND_NOW = "Respond to the participants now, briefly, then listen.";
const NO_NEW_SPEECH = "(no new participant speech; use the recent call transcript)";

export interface OpenAILiveOptions {
  apiKey: string;
  model: string;
  url?: string;
  /** Quiet gap in output audio/transcript that ends an assistant turn (synthetic responseDone). */
  outputGapMs?: number;
  /** Quiet gap in the input transcript that ends a participant turn (synthetic speechStopped). */
  inputGapMs?: number;
  /** Wait after session.delegation.created for trailing input transcript fragments. */
  delegateSettleMs?: number;
  /** How long close() waits for session.closed. */
  closeTimeoutMs?: number;
  /** A respond() with no output audio by then still gets a responseDone, so the steer queue never latches. */
  respondTimeoutMs?: number;
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const tail = (s: string, n: number): string => (s.length > n ? "…" + s.slice(s.length - n + 1) : s);
const text = (data: unknown): string => (typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer));

/** Fold slaude's tool list into GPT-Live's prompt-level delegation policy. */
export function withDelegationPolicy(instructions: string, tools: ToolSpec[]): string {
  if (tools.length === 0) return instructions;
  return [
    instructions.trim(),
    "",
    "Delegation policy:",
    "Backend tools:",
    ...tools.map((t) => `- ${t.name}: ${t.description}`),
    "",
    "Delegate to the backend when a request needs one of these capabilities, including leaving the call.",
    "Say a short holding line when you delegate. Do not guess the result while waiting.",
  ].join("\n").trim();
}

type Timer = ReturnType<typeof setTimeout>;

export class OpenAILive extends TypedEmitter<ProviderEvents> implements VoiceProvider {
  readonly caps: VoiceProviderCaps = { inputRate: 24000, outputRate: 24000, truncate: false };
  #ws: WebSocket | null = null;
  #closing = false;
  #ended = false;
  #abortConnect: ((message: string, fatal: boolean) => void) | null = null;
  #closeWaiter: (() => void) | null = null;
  #pendingContext: string | null = null;
  // Synthetic turn state.
  #outTurn = 0;
  #outOpen = false;
  #outAudio = false;
  #outText = "";
  #outTimer: Timer | null = null;
  #inTurn = 0;
  #inActive = false;
  #inText = "";
  #inTimer: Timer | null = null;
  #sinceDelegation: string[] = [];
  #delegateTimers = new Set<Timer>();
  #respondTimer: Timer | null = null;

  constructor(private o: OpenAILiveOptions) {
    super();
  }

  async connect(init: ProviderConnect): Promise<void> {
    this.#abortConnect?.("live connect superseded", false);
    this.#detach();
    this.#resetTurns();
    this.#closing = false;
    this.#ended = false;
    // No query parameters: the model goes in session.start. Bun's WebSocket
    // accepts request headers as a second-argument option.
    const ws = new WebSocket(this.o.url ?? "wss://api.openai.com/v1/live/sessions", {
      headers: { Authorization: `Bearer ${this.o.apiKey}` },
    } as any);
    this.#ws = ws;
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      let settled = false;
      // Every failed-handshake path: detach, close the socket, reject once.
      const fail = (message: string, fatal: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.#abortConnect === fail) this.#abortConnect = null;
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        if (this.#ws === ws) this.#ws = null;
        try { ws.close(1000, "connect failed"); } catch {}
        if (fatal) this.fire("error", { fatal: true, message });
        reject(new Error(message));
      };
      this.#abortConnect = fail;
      const timer = setTimeout(() => fail("live connect timeout", false), 10_000);
      ws.onopen = () => {
        this.#send({ type: "session.start", event_id: START_EVENT_ID, session: this.#sessionConfig(init) });
      };
      ws.onmessage = (ev) => {
        if (ws !== this.#ws) return;
        let m: any;
        try { m = JSON.parse(text(ev.data)); } catch { return; }
        if (!ready) {
          if (m?.type === "error") {
            // A rejected session.start never starts; resending the same config cannot help.
            return fail(String(m.error?.message ?? "live error"), isFatal(m.error) || m.error?.type === "invalid_request_error");
          }
          if (m?.type === "session.closed") return fail(`live session closed during startup (${m.reason ?? "unknown"})`, false);
          if (m?.type === "session.started") {
            ready = true;
            settled = true;
            clearTimeout(timer);
            if (this.#abortConnect === fail) this.#abortConnect = null;
            this.#applyExpiry(m.session?.expires_at);
            resolve();
          }
          return;
        }
        this.#onServer(m);
      };
      // A refused upgrade (e.g. a bad key) surfaces here before session.started: fatal.
      ws.onerror = () => {
        if (ws !== this.#ws) return;
        if (!ready) fail("live websocket error during handshake", true);
      };
      ws.onclose = () => {
        if (ws !== this.#ws) return;
        if (!ready) return fail("live connection closed during handshake", true);
        if (this.#closing) return this.#closeWaiter?.();
        this.#lost("live connection closed", false);
      };
    });
  }

  #sessionConfig(init: ProviderConnect): Record<string, unknown> {
    const session: Record<string, unknown> = {
      model: this.o.model,
      instructions: withDelegationPolicy(init.instructions, init.tools),
      audio: { format: { type: "audio/pcm", rate: 24000 }, ...(init.voice ? { output: { voice: init.voice } } : {}) },
      delegation: { type: "client" },
    };
    if (init.seed) {
      session.input = [
        { type: "message", role: "developer", content: [{ type: "input_text", text: seedText(tail(init.seed, SEED_MAX_CHARS)) }] },
      ];
    }
    return session;
  }

  #applyExpiry(expiresAt: unknown): void {
    if (typeof expiresAt !== "number") return;
    const sec = Math.floor(expiresAt - Date.now() / 1000);
    if (sec >= MIN_EXPIRY_SEC) this.caps.maxSessionSec = sec;
  }

  #onServer(m: any): void {
    if (this.#ended) return;
    if (this.#closing) {
      if (m?.type === "session.closed") this.#closeWaiter?.();
      return;
    }
    switch (m?.type) {
      case "session.output_audio.delta":
        if (typeof m.delta !== "string") return;
        this.#touchOutput(true);
        this.fire("audio", base64ToPcm(m.delta), `a${this.#outTurn}`);
        return;
      case "session.output_transcript.delta":
        if (typeof m.delta !== "string") return;
        this.#touchOutput(false);
        this.#outText += m.delta;
        return;
      case "session.input_transcript.delta":
        if (typeof m.delta !== "string") return;
        this.#touchInput();
        this.#inText += m.delta;
        return;
      case "session.delegation.created": {
        const id = m.delegation?.id;
        if (m.delegation?.target !== "client" || typeof id !== "string") return;
        const ws = this.#ws;
        const t = setTimeout(() => {
          this.#delegateTimers.delete(t);
          if (ws === this.#ws && !this.#closing) this.#delegate(id);
        }, this.o.delegateSettleMs ?? 300);
        this.#delegateTimers.add(t);
        return;
      }
      case "session.closed":
        // Unsolicited: expired / connection_lost / remote_hangup are drops; content is a safety stop.
        this.#lost(`live session closed: ${m.reason ?? "unknown"}`, m.reason === "content");
        return;
      case "error":
        this.fire("error", { fatal: isFatal(m.error), message: String(m.error?.message ?? "error") });
        return;
    }
  }

  #touchOutput(audio: boolean): void {
    if (!this.#outOpen) {
      this.#outOpen = true;
      this.#outTurn++;
    }
    if (audio) {
      this.#outAudio = true;
      this.#clearRespondTimer(); // the output gap now ends this response
    }
    if (this.#outTimer) clearTimeout(this.#outTimer);
    this.#outTimer = setTimeout(() => this.#endOutput(), this.o.outputGapMs ?? 600);
  }
  #endOutput(): void {
    if (this.#outTimer) clearTimeout(this.#outTimer);
    this.#outTimer = null;
    const hadAudio = this.#outAudio;
    this.#flushOutputText();
    this.#outOpen = false;
    this.#outAudio = false;
    if (hadAudio) this.fire("responseDone");
  }
  #flushOutputText(): void {
    const t = this.#outText.trim();
    this.#outText = "";
    if (t) this.fire("transcript", { role: "assistant", text: t, itemId: `a${this.#outTurn}` });
  }
  #touchInput(): void {
    if (!this.#inActive) {
      this.#inActive = true;
      this.#inTurn++;
      // speechStarted first: the Conductor's drain on the responseDone below then sees the speaker.
      this.fire("speechStarted");
      if (this.#outOpen) this.#endOutput();
    }
    if (this.#inTimer) clearTimeout(this.#inTimer);
    this.#inTimer = setTimeout(() => this.#endInput(), this.o.inputGapMs ?? 800);
  }
  #endInput(): void {
    this.#inTimer = null;
    this.#flushInputText();
    this.#inActive = false;
    this.fire("speechStopped");
  }
  #flushInputText(): void {
    const t = this.#inText.trim();
    this.#inText = "";
    if (!t) return;
    this.#sinceDelegation.push(t);
    if (this.#sinceDelegation.length > HISTORY_LINES) this.#sinceDelegation.shift();
    this.fire("transcript", { role: "user", text: t, itemId: `u${this.#inTurn}` });
  }
  #delegate(id: string): void {
    this.#flushInputText(); // the transcript lane gets the words before the delegate
    const task = tail(this.#sinceDelegation.join(" "), TASK_MAX_CHARS) || NO_NEW_SPEECH;
    this.#sinceDelegation = [];
    this.fire("toolCall", { callId: id, name: DELEGATE_TOOL, args: { task } });
  }

  #lost(message: string, fatal: boolean): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#flushTranscripts();
    this.#clearTimers();
    this.fire("error", { fatal, message });
    this.fire("closed");
  }
  #flushTranscripts(): void {
    this.#flushOutputText();
    this.#flushInputText();
  }
  #clearTimers(): void {
    if (this.#outTimer) clearTimeout(this.#outTimer);
    if (this.#inTimer) clearTimeout(this.#inTimer);
    for (const t of this.#delegateTimers) clearTimeout(t);
    this.#outTimer = this.#inTimer = null;
    this.#delegateTimers.clear();
    this.#clearRespondTimer();
  }
  #clearRespondTimer(): void {
    if (this.#respondTimer) clearTimeout(this.#respondTimer);
    this.#respondTimer = null;
  }
  #resetTurns(): void {
    this.#clearTimers();
    this.#pendingContext = null;
    this.#outTurn = 0;
    this.#outOpen = this.#outAudio = false;
    this.#outText = "";
    this.#inTurn = 0;
    this.#inActive = false;
    this.#inText = "";
    this.#sinceDelegation = [];
  }
  #detach(): void {
    const old = this.#ws;
    if (!old) return;
    this.#ws = null;
    old.onopen = old.onmessage = old.onerror = old.onclose = null;
    try { old.close(1000, "replaced"); } catch {}
  }

  #send(o: unknown): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(o));
  }
  #append(type: string, delegationId: string | null, content: string): void {
    this.#send({ type, delegation_id: delegationId, content: clip(content, APPEND_MAX_CHARS) });
  }
  #flushContext(): void {
    const t = this.#pendingContext;
    this.#pendingContext = null;
    if (t !== null && !this.#closing) this.#append("session.thinking.append", null, t);
  }

  sendAudio(pcm: Int16Array): void {
    if (this.#closing) return;
    this.#send({ type: "session.input_audio.append", audio: pcmToBase64(pcm) });
  }
  /** Silent context. Held for one microtask so an immediately following respond() can make it speech. */
  addContext(text: string): void {
    if (this.#pendingContext !== null) this.#flushContext();
    this.#pendingContext = text;
    queueMicrotask(() => this.#flushContext());
  }
  /** Speak now: the pending context goes out as commentary; with none, a short instruction. */
  respond(): void {
    if (this.#closing || this.#ended) return;
    const t = this.#pendingContext;
    this.#pendingContext = null;
    if (t !== null) this.#append("session.commentary.append", null, t);
    else this.#append("session.instructions.append", null, RESPOND_NOW);
    // The answer is a new response: end the open output turn without a responseDone
    // (the Conductor marks its own response active right after this call).
    if (this.#outOpen) {
      if (this.#outTimer) clearTimeout(this.#outTimer);
      this.#outTimer = null;
      this.#flushOutputText();
      this.#outOpen = this.#outAudio = false;
    }
    this.#clearRespondTimer();
    this.#respondTimer = setTimeout(() => {
      this.#respondTimer = null;
      if (!this.#closing && !this.#ended && !this.#outAudio) this.fire("responseDone");
    }, this.o.respondTimeoutMs ?? 5000);
  }
  /** No protocol equivalent: GPT-Live yields on its own, and the next append can interrupt speech. */
  cancel(): void {}
  /** Unsupported (caps.truncate = false); the Conductor never calls it. */
  truncate(_itemId: string, _ms: number): void {}
  /** Delegation acknowledgement or result, as silent context attached to that delegation. */
  toolResult(callId: string, output: unknown): void {
    const body = typeof output === "string" ? output : JSON.stringify(output);
    this.#append("session.thinking.append", callId, `Backend status for this request: ${body}`);
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#pendingContext = null;
    this.#abortConnect?.("live connection closed by client", false);
    const ws = this.#ws;
    if (!ws) return;
    this.#flushTranscripts();
    this.#clearTimers();
    if (ws.readyState === WebSocket.OPEN && !this.#ended) {
      // Graceful close: session.close, then keep reading until session.closed (bounded).
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(t);
          resolve();
        };
        const t = setTimeout(done, this.o.closeTimeoutMs ?? 3000);
        this.#closeWaiter = done;
        this.#send({ type: "session.close" });
      });
    }
    this.#closeWaiter = null;
    if (this.#ws === ws) this.#ws = null;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try { ws.close(1000, "done"); } catch {}
  }
}
