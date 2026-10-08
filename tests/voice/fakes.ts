import { TypedEmitter, type ProviderConnect, type ProviderEvents, type VoiceProvider, type VoiceProviderCaps } from "../../src/voice/provider/types";

export class FakeProvider extends TypedEmitter<ProviderEvents> implements VoiceProvider {
  caps: VoiceProviderCaps = { inputRate: 24000, outputRate: 24000, truncate: true };
  calls: Array<[string, ...unknown[]]> = [];
  connects: ProviderConnect[] = [];
  connectError: Error | null = null;
  async connect(init: ProviderConnect) {
    this.connects.push(init);
    if (this.connectError) throw this.connectError;
  }
  sendAudio(pcm: Int16Array) { this.calls.push(["sendAudio", pcm.length]); }
  addContext(text: string) { this.calls.push(["addContext", text]); }
  respond() { this.calls.push(["respond"]); }
  cancel() { this.calls.push(["cancel"]); }
  truncate(itemId: string, ms: number) { this.calls.push(["truncate", itemId, ms]); }
  toolResult(callId: string, output: unknown) { this.calls.push(["toolResult", callId, output]); }
  async close() { this.calls.push(["close"]); }
  emitEvent<K extends keyof ProviderEvents>(k: K, ...args: Parameters<ProviderEvents[K]>) {
    this.fire(k, ...(args as any));
  }
  named(name: string) { return this.calls.filter((c) => c[0] === name); }
}

export interface AudioHandlers { onAudio(pcm: Int16Array): void; onEnded(reason: string): void }
export class FakeAudio {
  written: Int16Array[] = [];
  clears = 0;
  clearResult = { playedMs: 0, clearedMs: 0 };
  handlers: AudioHandlers | null = null;
  closed = false;
  async start(h: AudioHandlers) { this.handlers = h; }
  write(pcm: Int16Array) { this.written.push(pcm); }
  async clear() { this.clears++; return this.clearResult; }
  async close() { this.closed = true; }
}

/** n samples of silence. */
export const pcm = (n: number) => new Int16Array(n);

/** Poll fn until it returns a truthy value or timeout expires (throws). */
export async function until(fn: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timeout waiting for condition (${timeoutMs}ms)`);
}

/** Async channel: send() pushes, recv() waits for next. */
export function chan<T>() {
  let pending: T[] = [];
  let waiters: ((v: T) => void)[] = [];
  return {
    send(v: T) {
      const waiter = waiters.shift();
      if (waiter) waiter(v);
      else pending.push(v);
    },
    async recv(): Promise<T> {
      if (pending.length > 0) return pending.shift()!;
      return new Promise((r) => waiters.push(r));
    },
  };
}
