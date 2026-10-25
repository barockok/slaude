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

/**
 * The user text without the per-turn `<memory-context>` block the gateway
 * puts in the envelope (the speaker's profile, commitments, channel notes).
 * The block is read for the turn only: synced into a conversation page it
 * would be readable outside the speaker's turns and survive a profile
 * correction. Page text inside the block is escaped, so it cannot close the
 * block early and a non-greedy match is safe. The system prompt's episodic
 * block of the same name never passes through here.
 */
export const stripTurnMemoryContext = (text: string): string =>
  text.replace(/<memory-context>\n[\s\S]*?\n<\/memory-context>\n*/g, "");
