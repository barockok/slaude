/**
 * Parent side of one voice call (voice mode spec §6-§7): owns the voice-loop
 * child, buffers the transcript, runs delegated turns on the warm session
 * through a TurnRunner, relays Claude's steering, and closes the call with a
 * transcript file and a summary turn.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { transcriptLine, type ChildMsg, type EndReason, type VoiceInit } from "./ipc";
import type { LoopChild } from "./spawn";
import { DEFAULT_MAX_WAIT_MS, VoiceAuthLost, VoiceTurnCancelled } from "./runners";
import { CapabilityRedactor } from "./audio-link";
import { liveCalls } from "./turn-flags";

export type { LoopChild } from "./spawn";

export interface TurnRunner {
  /** `cancelled` is required: the runner re-reads it after any wait, right
   *  before sending, and refuses the turn once it is true. */
  run(sessionId: string, text: string, o: { suppress: boolean; voice: boolean; cancelled(): boolean }): Promise<void>;
}

export const TRANSCRIPT_FLUSH_PREFIX = "[voice call transcript]";

export interface DelegateRequest {
  id: string;
  task: string;
}

const SPEAKABLE = "Speakable: short sentences, no markdown, no URLs or code read aloud.";

/** One turn's prompt for one or more delegated requests (requests that queued
 *  up behind a running turn are merged into one turn, each answered on its own). */
export function delegatePrompt(reqs: DelegateRequest[], transcript: string): string {
  const head = transcript ? `${TRANSCRIPT_FLUSH_PREFIX}\n${transcript}\n` : "";
  const body = reqs.length === 1
    ? [
        `Voice call request #${reqs[0]!.id}: ${reqs[0]!.task}`,
        `Answer with voice_say(reply_to="${reqs[0]!.id}"). ${SPEAKABLE}`,
      ]
    : [
        `Voice call requests ${reqs.map((r) => `#${r.id}`).join(", ")}:`,
        ...reqs.map((r) => `#${r.id}: ${r.task}`),
        `Answer each one separately with its own voice_say: ${reqs.map((r) => `reply_to="${r.id}"`).join(", ")}. ${SPEAKABLE}`,
      ];
  return [head, ...body, "Do not post to the Slack thread during the call."].filter(Boolean).join("\n");
}

/** How long a delegate may wait in the call's queue before it fails. The
 *  runner already gives up after DEFAULT_MAX_WAIT_MS when the session stays
 *  busy; a request queued behind a turn that is itself stuck should not wait
 *  longer than that, plus a margin for the turn ahead of it to wrap up. */
export const QUEUE_WAIT_MARGIN_MS = 15_000;
export const DEFAULT_QUEUE_WAIT_MS = DEFAULT_MAX_WAIT_MS + QUEUE_WAIT_MARGIN_MS;

/** Work waiting for the next turn: delegates plus a due transcript flush. It
 *  becomes one turn when it reaches the head of the queue; until then later
 *  delegates and flushes join it. */
interface Batch {
  delegates: Array<DelegateRequest & { timer: ReturnType<typeof setTimeout> }>;
  flush: boolean;
}

export function summaryPrompt(reason: EndReason, transcriptPath: string | null): string {
  return [
    `The voice call has ended (reason: ${reason}).`,
    "Call browser_audio_stop for the call's tab and leave the meeting in the browser if you are still in it.",
    "Then post a short summary to this thread: decisions, action items with owners, open questions." +
      (reason === "stopped" || reason === "ended_by_voice" ? "" : " Mention briefly why the call ended."),
    transcriptPath ? `Attach the transcript with the upload tool: ${transcriptPath}` : "",
  ].filter(Boolean).join("\n");
}

export interface VoiceCallDeps {
  sessionId: string;
  runner: TurnRunner;
  child: LoopChild;
  transcriptDir: string;
  /** Hold (or release) the session's idle timer. Returning `false` means the
   *  session was not live, so nothing was held; the call retries after each
   *  turn it runs, since a turn boots the session. */
  holdIdle(hold: boolean): boolean | void;
  onClosed(): void;
  idleFlushMs?: number;
  /** Longest a delegate waits in the queue before it fails (DEFAULT_QUEUE_WAIT_MS). */
  queueWaitMs?: number;
  startTimeoutMs?: number;
  /** How long to wait for the stdout stream to drain after the child exits
   *  before ending the call anyway. */
  exitGraceMs?: number;
}

export class VoiceCall {
  readonly callId = randomUUID();
  #lines: string[] = [];
  #pending: string[] = [];
  /** Seq of the newest transcript line buffered in #pending. */
  #pendingSeq = 0;
  /** Seq of the newest transcript line handed to the session. */
  #seenSeq = 0;
  /** Delegate id → the seq it was asked at, so its reply is judged stale
   *  against what Claude knew, not what the child had heard at tool time. */
  #delegateAsOf = new Map<string, number>();
  /** Requests Claude already answered (a voice_say with reply_to): a turn
   *  that fails afterwards does not tell the voice they failed. */
  #answered = new Set<string>();
  #queue: Promise<void> = Promise.resolve();
  /** The batch queued for the next turn and not started yet (null: none). */
  #batch: Batch | null = null;
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Epoch ms when the voice loop reported started (0 before). */
  startedAt = 0;
  #started = false;
  #timedOut = false;
  #exited = false;
  #held = false;
  #stopReason: EndReason | null = null;
  /** No further injected turn may run (the session rebooted or the identity
   *  changed): queued turns are dropped, nothing is flushed or summarized. */
  #cancelled = false;
  #endReason: EndReason | null = null;
  #resolveDone!: (r: EndReason) => void;
  readonly done: Promise<EndReason> = new Promise((r) => (this.#resolveDone = r));

  /** Masks the call's capability URLs (secret-bearing paths) in log text. */
  #scrub: (s: string) => string = (s) => s;

  constructor(private d: VoiceCallDeps) {}

  start(init: VoiceInit): Promise<void> {
    const r = new CapabilityRedactor(init.audio);
    this.#scrub = (s) => r.redact(s);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#timedOut = true;
        reject(new Error("voice loop did not start in time"));
        this.d.child.kill();
      }, this.d.startTimeoutMs ?? 20_000);
      const notStarted = (why: string) => {
        clearTimeout(timer);
        if (!this.#started) reject(new Error(why));
      };
      this.d.child.send({ type: "init", init });
      // A child that exits before its final `ended` line is flushed (or whose
      // stdout never closes) is a crash, unless we asked it to stop.
      void this.d.child.exited.then(() => {
        this.#exited = true;
        setTimeout(() => {
          notStarted("voice loop exited before start");
          void this.#close(this.#stopReason ?? "loop_crashed");
        }, this.d.exitGraceMs ?? 1_000).unref();
      });
      void (async () => {
        try {
          for await (const m of this.d.child.messages) {
            // After the start timeout the child is being killed: ignore a late
            // start (and anything it says) so no hold or summary turn happens.
            if (this.#timedOut && m.type !== "ended") continue;
            if (m.type === "started" && !this.#started) {
              this.#started = true;
              this.startedAt = Date.now();
              clearTimeout(timer);
              this.#hold();
              resolve();
            } else if (m.type === "ended") {
              notStarted(`voice loop ended before start: ${m.reason}`);
              await this.#close(m.reason, true);
              return;
            } else {
              this.#onChild(m);
            }
          }
        } catch (e) {
          console.error(`[voice] child stream failed session=${this.d.sessionId}:`, e instanceof Error ? e.message : e);
        }
        notStarted("voice loop exited before start");
        await this.#close(this.#stopReason ?? "loop_crashed");
      })();
    });
  }

  #hold(): void {
    this.#held = this.d.holdIdle(true) !== false;
  }

  #onChild(m: ChildMsg): void {
    // After close (the process exited, its stdout still open) nothing more is
    // queued: a batch would run after the summary with no live call.
    if (this.#endReason && (m.type === "transcript" || m.type === "delegate")) return;
    if (m.type === "transcript") {
      this.#pendingSeq = m.seq;
      const line = transcriptLine(m.role, m.text);
      this.#lines.push(line);
      this.#pending.push(line);
      this.#armFlush();
    } else if (m.type === "delegate") {
      this.#delegateAsOf.set(m.id, m.asOf);
      const b = this.#openBatch();
      const timer = setTimeout(() => this.#expire(b, m.id), this.d.queueWaitMs ?? DEFAULT_QUEUE_WAIT_MS);
      timer.unref?.();
      b.delegates.push({ id: m.id, task: m.task, timer });
    } else if (m.type === "log") {
      console[m.level === "error" ? "error" : m.level === "warn" ? "warn" : "log"](`[voice] session=${this.d.sessionId} ${this.#scrub(m.message)}`);
    }
  }

  /** The batch for the next turn, queued once when created. */
  #openBatch(): Batch {
    if (this.#batch) return this.#batch;
    const b: Batch = { delegates: [], flush: false };
    this.#batch = b;
    this.#enqueue(() => this.#runBatch(b));
    return b;
  }

  #failRequest(id: string): void {
    this.say(`Request #${id} failed. Tell the participants you could not get that.`, "next_gap", id);
  }

  /** A delegate waited too long behind the turn ahead of it: drop it from the
   *  batch (it never runs) and answer it through the voice. */
  #expire(b: Batch, id: string): void {
    if (this.#batch !== b) return; // started (or the call was torn down)
    const i = b.delegates.findIndex((d) => d.id === id);
    if (i < 0) return;
    b.delegates.splice(i, 1);
    if (this.#cancelled || this.#endReason) return;
    console.error(`[voice] request #${id} waited too long in the queue session=${this.d.sessionId}`);
    this.#failRequest(id);
  }

  /** Run a batch at the head of the queue: from here nothing joins it. The
   *  transcript is taken now, so a queued delegate carries what was said
   *  while it waited. */
  async #runBatch(b: Batch): Promise<void> {
    if (this.#batch === b) this.#batch = null;
    for (const d of b.delegates) clearTimeout(d.timer);
    const reqs = b.delegates.map(({ id, task }) => ({ id, task }));
    if (!reqs.length) {
      // Every delegate in it expired and no flush was due: nothing to send.
      if (!b.flush) return;
      const t = this.#takePending();
      if (!t) return;
      try {
        await this.#run(`${TRANSCRIPT_FLUSH_PREFIX}\n${t}`, { suppress: true, voice: true });
      } catch (e) {
        this.#restore(t, e);
        throw e;
      }
      return;
    }
    const transcript = this.#takePending();
    try {
      await this.#run(delegatePrompt(reqs, transcript), { suppress: false, voice: true });
    } catch (e) {
      const ids = reqs.map((r) => `#${r.id}`).join(", ");
      console.error(`[voice] request ${ids} failed session=${this.d.sessionId}:`, e instanceof Error ? e.message : e);
      this.#restore(transcript, e);
      if (e instanceof VoiceAuthLost) return this.#authLost();
      // A cancelled turn is the call going away, not a failed request.
      if (e instanceof VoiceTurnCancelled || this.#cancelled) return;
      for (const r of reqs) if (!this.#answered.has(r.id)) this.#failRequest(r.id);
    }
  }

  /** A turn failed: Claude may never have seen its transcript chunk, so carry
   *  it in the next flush, and re-arm the flush so it goes in even if nobody
   *  speaks again (not when the call is going away). */
  #restore(transcript: string, e: unknown): void {
    if (!transcript) return;
    this.#pending.unshift(transcript);
    if (e instanceof VoiceAuthLost || e instanceof VoiceTurnCancelled) return;
    if (!this.#cancelled && !this.#endReason) this.#armFlush();
  }

  #takePending(): string {
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
    const t = this.#pending.join("\n");
    this.#pending = [];
    if (this.#pendingSeq > this.#seenSeq) this.#seenSeq = this.#pendingSeq;
    return t;
  }
  /** Feed the unsent transcript into the session: a suppressed turn of its
   *  own, or part of the delegate turn already queued. Taken when that turn
   *  starts. */
  #flushPending(): void {
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
    if (!this.#pending.length) return;
    this.#openBatch().flush = true;
  }
  #armFlush(): void {
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#flushTimer = setTimeout(() => this.#flushPending(), this.d.idleFlushMs ?? 30_000);
  }
  /** One injected turn. The runner re-checks the thread's identity at the
   *  point of use and throws VoiceAuthLost when it is no longer the agent. */
  #run(text: string, o: { suppress: boolean; voice: boolean }): Promise<void> {
    return this.d.runner.run(this.d.sessionId, text, { ...o, cancelled: () => this.#cancelled });
  }
  /** End the call `auth_lost` (any turn path). Not stop(): it waits for the
   *  turn queue, which the caller is on. */
  #authLost(): void {
    this.#cancelled = true;
    if (this.#endReason || this.#stopReason) return;
    this.#stopReason = "auth_lost";
    this.d.child.send({ type: "stop", reason: "auth_lost" });
    setTimeout(() => this.d.child.kill(), 5_000).unref();
  }
  #enqueue(fn: () => Promise<void>): void {
    this.#queue = this.#queue
      .then(() => (this.#cancelled ? undefined : fn()))
      .catch((e) => {
        console.error(`[voice] turn failed session=${this.d.sessionId}:`, e instanceof Error ? e.message : e);
        if (e instanceof VoiceAuthLost) this.#authLost();
      })
      .then(() => {
        // The session may not have been live when the call started; a turn boots it.
        if (this.#started && !this.#held && !this.#endReason) this.#hold();
      });
  }

  say(text: string, when: "next_gap" | "now", replyTo?: string): void {
    if (replyTo !== undefined) this.#answered.add(replyTo);
    const asOf = (replyTo !== undefined ? this.#delegateAsOf.get(replyTo) : undefined) ?? this.#seenSeq;
    this.d.child.send({ type: "say", text, when, replyTo, asOf });
  }
  context(text: string): void {
    this.d.child.send({ type: "context", text });
  }
  async stop(reason: EndReason): Promise<void> {
    if (this.#endReason) return void (await this.done);
    // A rebooted session or a lost identity: cancel now, not when the child's
    // `ended` arrives — queued turns and a turn waiting in the runner must not
    // reach the (new) session in the meantime.
    if (reason === "session_rebooted" || reason === "auth_lost") this.#cancelled = true;
    this.#stopReason ??= reason;
    this.d.child.send({ type: "stop", reason });
    const t = setTimeout(() => this.d.child.kill(), 5_000).unref();
    await this.done;
    clearTimeout(t);
  }

  /** Make sure the child is gone. The stream may have ended (or failed) while
   *  the process lives on with its provider socket open. After a clean `ended`
   *  the child may still be closing its provider and audio, so it gets a grace
   *  period first. */
  #reap(graceful: boolean): void {
    if (this.#exited) return;
    if (!graceful) return this.d.child.kill();
    setTimeout(() => {
      if (!this.#exited) this.d.child.kill();
    }, this.d.exitGraceMs ?? 1_000).unref();
  }

  async #close(reason: EndReason, graceful = false): Promise<void> {
    if (this.#endReason) return;
    this.#endReason = reason;
    // A cancelled close never flushes: disarm the idle flush either way.
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
    this.#reap(graceful);
    let path: string | null = null;
    if (this.#lines.length) {
      path = join(this.d.transcriptDir, `voice-call-${this.callId}.txt`);
      try {
        writeFileSync(path, this.#lines.join("\n") + "\n", { mode: 0o600 });
      } catch (e) {
        console.error(`[voice] transcript write failed session=${this.d.sessionId}:`, e instanceof Error ? e.message : e);
        path = null;
      }
    }
    // A rebooted session is not the one that held the call, and a lost
    // identity may not run as the agent: queued turns are dropped and nothing
    // is fed into the session — the transcript file is all that remains.
    if (reason === "session_rebooted" || reason === "auth_lost") this.#cancelled = true;
    if (this.#cancelled && this.#batch) {
      for (const d of this.#batch.delegates) clearTimeout(d.timer);
      this.#batch = null;
    }
    if (!this.#cancelled) {
      this.#flushPending();
      if (this.#started) {
        this.#enqueue(() => {
          // Every mid-call turn ran with the call registered (no auto-evolve);
          // the summary runs without it, so the call's lessons can be learned.
          liveCalls.delete(this.d.sessionId);
          return this.#run(summaryPrompt(reason, path), { suppress: false, voice: false });
        });
      }
    }
    await this.#queue;
    if (this.#started) this.d.holdIdle(false);
    this.d.onClosed();
    this.#resolveDone(reason);
  }
}

export class VoiceCalls {
  #calls = new Map<string, VoiceCall>();
  #reserved = new Set<string>();
  /** Claim the thread's slot synchronously, before any await, so two parallel
   *  starts cannot both pass the busy check. False when a call or another
   *  start already holds it. Pair with release() on every path. */
  reserve(sessionId: string): boolean {
    if (this.#calls.has(sessionId) || this.#reserved.has(sessionId)) return false;
    this.#reserved.add(sessionId);
    return true;
  }
  release(sessionId: string): void {
    this.#reserved.delete(sessionId);
  }
  get(sessionId: string): VoiceCall | undefined {
    return this.#calls.get(sessionId);
  }
  add(sessionId: string, call: VoiceCall): void {
    this.#calls.set(sessionId, call);
    liveCalls.add(sessionId);
  }
  remove(sessionId: string): void {
    this.#calls.delete(sessionId);
    liveCalls.delete(sessionId);
  }
  async end(sessionId: string, reason: EndReason): Promise<void> {
    await this.#calls.get(sessionId)?.stop(reason);
  }
  /** Node drain: say a short goodbye on every call, give it a moment to play,
   *  then end each call with `reason`. */
  async endAll(reason: EndReason, farewell = "I have to drop off now. I'll post a summary in the thread.", waitMs = 4_000): Promise<void> {
    for (const c of this.#calls.values()) c.say(farewell, "now");
    if (this.#calls.size && waitMs > 0) await Bun.sleep(waitMs);
    await Promise.all([...this.#calls.keys()].map((id) => this.end(id, reason)));
  }
}
