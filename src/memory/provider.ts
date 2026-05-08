/**
 * Memory provider interface (mirrors hermes MemoryManager shape).
 *
 * Lifecycle per turn:
 *   prefetch(sessionId)  →  string | null  (wrapped in <memory-context> in system prompt)
 *   syncTurn({sessionId, user, assistant})  (post-turn write)
 *
 * Lifecycle hooks:
 *   onSessionSwitch / onPreCompress are optional and reserved for future use.
 */

export type SyncTurn = {
  sessionId: string;
  user: string;
  assistant: string;
};

export interface MemoryProvider {
  prefetch(sessionId: string): Promise<string | null>;
  syncTurn(turn: SyncTurn): Promise<void>;
  onSessionSwitch?(fromId: string, toId: string): Promise<void>;
  onPreCompress?(sessionId: string): Promise<void>;
}

export const NULL_PROVIDER: MemoryProvider = {
  async prefetch() {
    return null;
  },
  async syncTurn() {},
};
