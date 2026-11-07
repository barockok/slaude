/**
 * What a session is doing right now, for the console. The stored status is
 * not that: `running` means the session's CLI process was started and not yet
 * closed (it stays so across a whole warm idle period), and a row whose node
 * went away keeps `running` until something writes it again. The runtime
 * relies on those semantics, so they stay; the console reads liveness from
 * where it actually lives:
 *
 *   - gateway role: the warm registry (`sess:<id>`, src/queue/registry.ts),
 *     and the session's event stream for whether a turn is in flight (the
 *     newest turn boundary: a `turnStart` after the last `done`/`error`);
 *   - mono: the AgentManager's in-process live map and outstanding inputs.
 */
import type { SessionActivity } from "./api-types";
import type { PubSub } from "../../queue/pubsub";

/** In-process liveness (mono): the AgentManager's live map. */
export interface LocalSessions {
  /** The session's CLI process is up in this process. */
  isWarm(sessionId: string): boolean;
  /** A turn is in flight (an input is outstanding). */
  turnInFlight(sessionId: string): boolean;
  /** How many sessions are warm in this process. */
  count(): number;
}

/** How far back the stream is read for the newest turn boundary. */
const RECENT_EVENTS = 200;

/**
 * Whether a turn is in flight per the session's event stream: the newest
 * turn boundary is a `turnStart`. Undefined when the stream has none in its
 * recent window or cannot be read.
 */
export async function streamTurnInFlight(pubsub: PubSub | null, sessionId: string): Promise<boolean | undefined> {
  if (!pubsub) return undefined;
  try {
    for (const { event } of await pubsub.recentEvents(sessionId, RECENT_EVENTS)) {
      const e = event as { type?: unknown; autoEvolve?: unknown } | null;
      if (!e || typeof e !== "object") continue;
      if (e.type === "turnStart") return true;
      if (e.type === "error" || (e.type === "done" && !e.autoEvolve)) return false;
    }
  } catch {
    /* stream unreadable: unknown */
  }
  return undefined;
}

/** The console's activity from warmth, the in-flight flag and the stored status. */
export function activityOf(status: string, warm: boolean, inFlight: boolean | undefined): SessionActivity {
  if (warm) return inFlight ? "working" : "warm";
  return status === "error" ? "error" : "idle";
}
