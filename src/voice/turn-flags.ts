/**
 * Which sessions are running a voice-origin turn right now, in THIS process
 * (plan deviation 3). The turn runs where the warm session lives, and so do the
 * tools that post to Slack (mono: the in-process surface; node: the tool shim),
 * so a process-local flag is authoritative — no shared store needed.
 */
import { suppressibleSurface } from "../gateway/panel/suppress";
import type { Surface } from "../gateway/core/surface";

/** A counted per-session flag set (nested enters stack; exit never goes negative). */
function turnFlags() {
  const counts = new Map<string, number>();
  return {
    enter(sessionId: string): void {
      counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
    },
    exit(sessionId: string): void {
      const n = (counts.get(sessionId) ?? 0) - 1;
      if (n > 0) counts.set(sessionId, n);
      else counts.delete(sessionId);
    },
    active(sessionId: string): boolean {
      return (counts.get(sessionId) ?? 0) > 0;
    },
  };
}

/** Voice-origin turns: user-visible Slack writes are dropped. */
export const voiceTurns = turnFlags();

/** Every runner-injected turn (voice, transcript flush, summary): the node
 *  worker keeps its done/error out of the shared event stream. */
export const injectedTurns = turnFlags();

export const VOICE_QUIET_TOOLS: ReadonlySet<string> = new Set(["reply", "edit", "react", "unreact", "upload", "typing"]);

/** Tools on the deprecated `slaude_slack` server that post into Slack. */
export const VOICE_QUIET_SLACK_TOOLS: ReadonlySet<string> = new Set(["reply", "post_message"]);

/** What a suppressed write returns to the model. */
export const VOICE_SUPPRESSED_RESULT = { content: [{ type: "text" as const, text: JSON.stringify({ ref: "voice-suppressed" }) }] };

export function quietForVoice(surface: Surface, sessionId: string): Surface {
  return suppressibleSurface(surface, sessionId, async (id) => voiceTurns.active(id));
}
