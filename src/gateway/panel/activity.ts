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

/** The stream window read first; a session with a long turn (many tool
 *  events since its turnStart) is read again with the wider one. */
const SMALL_WINDOW = 20;
const WIDE_WINDOW = 200;

/** The newest turn boundary in events newest first: true = a turn started, false = one ended, undefined = none. */
export function turnBoundary(newestFirst: ReadonlyArray<{ event: unknown }>): boolean | undefined {
  for (const { event } of newestFirst) {
    const e = event as { type?: unknown; autoEvolve?: unknown } | null;
    if (!e || typeof e !== "object") continue;
    if (e.type === "turnStart") return true;
    if (e.type === "error" || (e.type === "done" && !e.autoEvolve)) return false;
  }
  return undefined;
}

/**
 * Whether a turn is in flight per each session's event stream (the newest
 * turn boundary is a `turnStart`). One pipelined read of the last 20 events
 * for all sessions, then one of the last 200 for those whose window had no
 * boundary: at most two round trips, whatever the number of sessions.
 * Undefined for a session with no boundary in reach or an unreadable stream.
 */
export async function streamTurnsInFlight(pubsub: PubSub | null, sessionIds: readonly string[]): Promise<Map<string, boolean | undefined>> {
  const out = new Map<string, boolean | undefined>();
  if (!pubsub || sessionIds.length === 0) return out;
  try {
    const small = await pubsub.recentEventsMany(sessionIds, SMALL_WINDOW);
    const widen: string[] = [];
    sessionIds.forEach((id, i) => {
      const events = small[i] ?? [];
      const b = turnBoundary(events);
      out.set(id, b);
      if (b === undefined && events.length >= SMALL_WINDOW) widen.push(id);
    });
    if (widen.length > 0) {
      const wide = await pubsub.recentEventsMany(widen, WIDE_WINDOW);
      widen.forEach((id, i) => out.set(id, turnBoundary(wide[i] ?? [])));
    }
  } catch {
    /* stream unreadable: unknown */
  }
  return out;
}

/** streamTurnsInFlight for one session. */
export async function streamTurnInFlight(pubsub: PubSub | null, sessionId: string): Promise<boolean | undefined> {
  return (await streamTurnsInFlight(pubsub, [sessionId])).get(sessionId);
}

/** The console's activity from warmth, the in-flight flag and the stored status. */
export function activityOf(status: string, warm: boolean, inFlight: boolean | undefined): SessionActivity {
  if (warm) return inFlight ? "working" : "warm";
  return status === "error" ? "error" : "idle";
}
