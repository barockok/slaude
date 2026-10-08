/**
 * Provider-agnostic realtime voice interface (voice mode spec §5.1). Adapters
 * translate one vendor wire protocol into these events and methods; nothing
 * outside src/voice/provider/ knows a vendor event name.
 */
export interface VoiceProviderCaps {
  inputRate: 16000 | 24000;
  outputRate: 16000 | 24000;
  truncate: boolean;
  maxSessionSec?: number;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProviderEvents {
  audio: (pcm: Int16Array, itemId: string) => void;
  transcript: (t: { role: "user" | "assistant"; text: string; itemId: string }) => void;
  speechStarted: () => void;
  speechStopped: () => void;
  responseDone: () => void;
  toolCall: (c: { callId: string; name: string; args: unknown }) => void;
  error: (e: { fatal: boolean; message: string }) => void;
  closed: () => void;
}

export interface ProviderConnect {
  instructions: string;
  tools: ToolSpec[];
  voice?: string;
  /** Prior conversation to restore after a reconnect (plain text). */
  seed?: string;
}

export interface VoiceProvider {
  readonly caps: VoiceProviderCaps;
  connect(init: ProviderConnect): Promise<void>;
  sendAudio(pcm: Int16Array): void;
  addContext(text: string): void;
  respond(): void;
  cancel(): void;
  truncate(itemId: string, ms: number): void;
  toolResult(callId: string, output: unknown): void;
  close(): Promise<void>;
  on<K extends keyof ProviderEvents>(k: K, cb: ProviderEvents[K]): void;
}

export class TypedEmitter<E> {
  #subs = new Map<keyof E, Array<(...a: any[]) => void>>();
  on<K extends keyof E>(k: K, cb: E[K]): void {
    const list = this.#subs.get(k) ?? [];
    list.push(cb as unknown as (...a: any[]) => void);
    this.#subs.set(k, list);
  }
  protected fire<K extends keyof E>(k: K, ...args: E[K] extends (...a: infer A) => any ? A : never): void {
    for (const cb of this.#subs.get(k) ?? []) {
      try {
        cb(...args);
      } catch (e) {
        console.error(`[voice] listener for ${String(k)} threw:`, e instanceof Error ? e.message : e);
      }
    }
  }
}

/** Prefix session seed with conversation context label. */
export function seedText(seed: string): string {
  return "Conversation so far (restored after reconnect):\n" + seed;
}

/** PCM s16le helpers shared by adapters and the audio link. */
export function pcmToBase64(pcm: Int16Array): string {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");
}
export function base64ToPcm(b64: string): Int16Array {
  const bytes = Uint8Array.from(Buffer.from(b64, "base64")); // copy → aligned buffer
  return new Int16Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 2));
}
