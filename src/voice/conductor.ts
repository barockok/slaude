/**
 * Conversation glue between the realtime provider, the browser audio pipe and the
 * Claude session (voice mode spec §5.4). No I/O of its own: everything goes
 * through ConductorIO, and time comes in through tick(now), so tests drive it
 * with scripted events.
 *
 * It makes no interruption decisions — the provider does. It only flushes the
 * audio it already handed to the audio pipe (a realtime model emits faster than real
 * time) and truncates the model's item to what was actually heard.
 */
import { transcriptLine, type ChildMsg, type EndReason, type SayMsg } from "./ipc";
import type { ToolSpec, VoiceProvider } from "./provider/types";

export const STILL_WORKING_MS = 60_000;
export const CAP_WARNING_MS = 120_000;
export const RECONNECT_LEAD_MS = 60_000;
/** How long after speechStopped we wait for the provider's own reply before treating it as a gap. */
export const AUTO_RESPONSE_WAIT_MS = 1_500;
/** How often the counters line is logged. */
export const COUNTERS_EVERY_MS = 60_000;
/** Open (unanswered) delegates kept; the oldest is forgotten past this. */
export const MAX_OPEN_DELEGATES = 32;

export const VOICE_TOOLS: ToolSpec[] = [
  {
    name: "delegate",
    description:
      "Hand a question or task to your back-office brain (it can search knowledge, use tools, and act). " +
      "Returns immediately; the answer comes back later as context. Say a short holding line first.",
    parameters: { type: "object", properties: { task: { type: "string", description: "What to find out or do, self-contained." } }, required: ["task"] },
  },
  {
    name: "end_call",
    description: "Leave the call. Use only when asked to leave or when the conversation is clearly over.",
    parameters: { type: "object", properties: { reason: { type: "string" } } },
  },
];

export interface ConductorIO {
  provider: Pick<VoiceProvider, "caps" | "addContext" | "respond" | "cancel" | "truncate" | "toolResult">;
  audio: {
    write(pcm: Int16Array): void;
    clear(): Promise<{ playedMs: number } | null>;
    /** The uplink clock (ms of audio written, keepalive silence included), when the link keeps one. */
    clockMs?(): number;
  };
  emit(m: ChildMsg): void;
  end(reason: EndReason): void;
  reconnect(): void;
}
export interface ConductorOpts {
  outputRate: number;
  staleSeq: number;
  maxMs: number;
  startedAt: number;
}

export class Conductor {
  #seq = 0;
  #log: string[] = [];
  #userSpeaking = false;
  #responseActive = false;
  #sentMs = 0;
  #itemStart = new Map<string, number>();
  #currentItem: string | null = null;
  // A steer may answer a delegate (callId: the provider's id for it) or be the
  // still-working nudge for one (nudgeFor: the Conductor's id).
  #steers: Array<{ text: string; callId?: string; nudgeFor?: string }> = [];
  #delegates = new Map<string, { askedAt: number; nudged: boolean; callId?: string }>();
  // The steer last handed to the provider, until a response finishes. A
  // provider may hold a create (Realtime does during an active response); a
  // reconnect loses it with the socket, so this one is queued again.
  #inFlight: { text: string; callId?: string } | null = null;
  #counters = { clears: 0, speechStarted: 0, delegates: 0, steersSpoken: 0 };
  #countersAt: number;
  #nextDelegate = 1;
  #warned = false;
  #ended = false;
  #sessionStartedAt: number;
  #reconnectRequested = false;
  #awaitingAuto: number | null = null;
  #lastTick: number;
  #staleDones = 0;
  #flushedItem: string | null = null;

  constructor(private io: ConductorIO, private o: ConductorOpts) {
    this.#sessionStartedAt = o.startedAt;
    this.#lastTick = o.startedAt;
    this.#countersAt = o.startedAt;
  }

  get seq(): number {
    return this.#seq;
  }
  /** Delegates asked and not yet answered. */
  get openDelegates(): number {
    return this.#delegates.size;
  }
  setProvider(p: ConductorIO["provider"]): void {
    this.io = { ...this.io, provider: p };
  }

  onAudio(pcm: Int16Array, itemId: string): void {
    if (itemId === this.#flushedItem) return; // late deltas of an answer we already cut off
    this.#awaitingAuto = null;
    if (!this.#itemStart.has(itemId)) this.#itemStart.set(itemId, this.#clock());
    this.#currentItem = itemId;
    this.#responseActive = true;
    this.io.audio.write(pcm);
    this.#sentMs += (pcm.length * 1000) / this.o.outputRate;
  }

  async onSpeechStarted(): Promise<void> {
    this.#userSpeaking = true;
    this.#counters.speechStarted++;
    // A full-duplex provider yields to the speaker itself; clearing here on
    // every detected speech start (echo, backchannel) only chops the agent.
    if (this.io.provider.caps.handlesBargeIn) return;
    await this.#flush();
  }
  onSpeechStopped(): void {
    this.#userSpeaking = false;
    // Both providers answer user speech on their own; draining now would collide with that reply.
    this.#awaitingAuto = this.#lastTick;
  }
  onResponseDone(): void {
    if (this.#staleDones > 0) {
      this.#staleDones--; // the cancelled response's done, not the live one's
      return;
    }
    this.#responseActive = false;
    this.#inFlight = null;
    this.#drain();
  }

  onTranscript(t: { role: "user" | "assistant"; text: string; itemId?: string }): void {
    this.#seq++;
    this.#log.push(transcriptLine(t.role, t.text));
    if (this.#log.length > 200) this.#log.shift();
    this.io.emit({ type: "transcript", seq: this.#seq, role: t.role, text: t.text });
  }
  recentTranscript(n: number): string {
    return this.#log.slice(-n).join("\n");
  }

  onToolCall(c: { callId: string; name: string; args: unknown }, now: number): void {
    if (this.#ended) return;
    const args = (c.args ?? {}) as Record<string, unknown>;
    if (c.name === "delegate") {
      const id = String(this.#nextDelegate++);
      this.#delegates.set(id, { askedAt: now, nudged: false, callId: c.callId });
      this.#counters.delegates++;
      while (this.#delegates.size > MAX_OPEN_DELEGATES) {
        const oldest = this.#delegates.keys().next().value as string;
        this.#forgetDelegate(oldest);
      }
      this.io.provider.toolResult(c.callId, { id, status: "working" });
      this.io.emit({ type: "delegate", id, task: String(args.task ?? "").trim(), asOf: this.#seq });
      return;
    }
    if (c.name === "end_call") {
      this.io.provider.toolResult(c.callId, { ok: true });
      this.#finish("ended_by_voice");
      return;
    }
    this.io.provider.toolResult(c.callId, { error: `unknown tool ${c.name}` });
  }

  async say(m: SayMsg): Promise<void> {
    if (this.#ended) return;
    const callId = m.replyTo ? this.#delegates.get(m.replyTo)?.callId : undefined;
    if (m.replyTo) this.#forgetDelegate(m.replyTo);
    const stale = this.#seq - m.asOf > this.o.staleSeq;
    if (m.when === "now" && !stale) {
      if (this.#responseActive) {
        if (this.io.provider.caps.cancelEmitsDone) this.#staleDones++;
        this.io.provider.cancel();
      }
      // Models emit faster than real time: audio may still be queued after the response is done.
      await this.#flush();
      this.#speak(m.text, callId);
      return;
    }
    this.#steers.push({ text: m.text, callId });
    this.#drain();
  }

  context(text: string): void {
    this.io.provider.addContext(text);
  }

  tick(now: number): void {
    if (this.#ended) return;
    this.#lastTick = now;
    if (this.#awaitingAuto !== null && now - this.#awaitingAuto >= AUTO_RESPONSE_WAIT_MS) this.#awaitingAuto = null;
    const elapsed = now - this.o.startedAt;
    if (elapsed >= this.o.maxMs) {
      this.#finish("max_duration");
      return;
    }
    if (!this.#warned && elapsed >= this.o.maxMs - CAP_WARNING_MS) {
      this.#warned = true;
      this.#steers.push({ text: "Let the participants know you have about two minutes left in this call." });
    }
    for (const [id, d] of this.#delegates) {
      if (!d.nudged && now - d.askedAt >= STILL_WORKING_MS) {
        d.nudged = true;
        this.#steers.push({ text: `You are still working on request #${id}; say briefly that it is taking a little longer.`, nudgeFor: id });
      }
    }
    const limit = this.io.provider.caps.maxSessionSec;
    if (limit && !this.#reconnectRequested && this.#gap() && now - this.#sessionStartedAt >= limit * 1000 - RECONNECT_LEAD_MS) {
      this.#reconnectRequested = true;
      this.io.reconnect();
      return;
    }
    this.#drain();
    if (now - this.#countersAt >= COUNTERS_EVERY_MS) this.#logCounters(now);
  }

  onReconnected(now: number): void {
    this.#sessionStartedAt = now;
    this.#reconnectRequested = false;
    this.#responseActive = false;
    this.#userSpeaking = false;
    this.#awaitingAuto = null;
    this.#staleDones = 0;
    this.#flushedItem = null;
    this.#itemStart.clear();
    this.#currentItem = null;
    // Delegation ids belong to the old provider session; the new one does not know them.
    if (this.#inFlight) this.#steers.unshift(this.#inFlight);
    this.#inFlight = null;
    for (const d of this.#delegates.values()) d.callId = undefined;
    for (const s of this.#steers) s.callId = undefined;
  }

  #gap(): boolean {
    return !this.#userSpeaking && !this.#responseActive && this.#awaitingAuto === null;
  }
  #drain(): void {
    if (!this.#gap()) return;
    const next = this.#steers.shift();
    if (next !== undefined) this.#speak(next.text, next.callId);
  }
  #speak(text: string, replyTo?: string): void {
    this.io.provider.addContext(`Say this to the participants now, in your own words and voice: ${text}`);
    if (replyTo === undefined) this.io.provider.respond();
    else this.io.provider.respond(replyTo);
    this.#responseActive = true;
    this.#inFlight = { text, callId: replyTo };
    this.#counters.steersSpoken++;
  }
  /** Close a delegate: answered, evicted, or the call ended. Its queued nudge goes too. */
  #forgetDelegate(id: string): void {
    this.#delegates.delete(id);
    this.#steers = this.#steers.filter((s) => s.nudgeFor !== id);
  }
  #clock(): number {
    return this.io.audio.clockMs ? this.io.audio.clockMs() : this.#sentMs;
  }
  #logCounters(now: number): void {
    const c = this.#counters;
    const secs = Math.round((now - this.#countersAt) / 1000);
    this.io.emit({
      type: "log", level: "info",
      message: `counters (${secs}s): clears=${c.clears} speechStarted=${c.speechStarted} delegates=${c.delegates} steersSpoken=${c.steersSpoken}`,
    });
    this.#counters = { clears: 0, speechStarted: 0, delegates: 0, steersSpoken: 0 };
    this.#countersAt = now;
  }
  async #flush(): Promise<void> {
    // Capture the item before the clear round trip: the provider's next item may
    // start during it, and that one must not be the one marked flushed.
    const item = this.#currentItem;
    this.#flushedItem = item;
    this.#counters.clears++;
    // Read before the clear: a link that keeps the clock resets it to played_ms inside clear().
    const sentBefore = this.#clock();
    const cleared = await this.io.audio.clear().catch(() => null);
    if (this.#currentItem === item) this.#currentItem = null;
    // A failed clear: what played is unknown, so neither truncate the model's
    // memory nor move the uplink clock (0 ms would be a lie). The item's late
    // audio is still dropped through #flushedItem.
    if (!cleared) {
      this.io.emit({ type: "log", level: "warn", message: "audio clear failed; queued audio may still play" });
      return;
    }
    const { playedMs } = cleared;
    if (item && this.io.provider.caps.truncate && playedMs < sentBefore) {
      const start = this.#itemStart.get(item) ?? 0;
      this.io.provider.truncate(item, Math.max(0, Math.round(playedMs - start)));
    }
    // Everything not yet played was discarded by the audio pipe: the uplink clock
    // resumes from what actually played.
    this.#sentMs = playedMs;
  }
  #finish(reason: EndReason): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#delegates.clear();
    this.#steers = [];
    this.io.end(reason);
  }
}