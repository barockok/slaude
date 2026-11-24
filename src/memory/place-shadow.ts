/**
 * Memory places, shadow measurement (rc.45). At each write point a later release will redirect,
 * work out where the write WOULD go under the places design and count it. Nothing here changes a
 * write: it never throws, never awaits, and a failure to compute is swallowed.
 *
 * Decisions (spec section 1):
 *  - A write that lands in the agent's own `agent-<id>` slice today is the one the place takes
 *    over: `would-write-place` with a place, `would-write-none` without one (the unknown-place
 *    case, counted by reason in `slaude_memory_place_unknown_total`).
 *  - A write that already lands elsewhere (a person's slice, a profile, `shared`, `public`)
 *    is `same-as-today`: the place is not its default target.
 *
 * `surface` is one of a fixed set of write points, never a channel or session id.
 */
import { env } from "../config/env";
import { agentSourceId } from "../knowledge/scope";
import { m } from "../metrics";
import type { NoPlaceReason, PlaceRef } from "./place";

export const WRITE_SURFACES = ["memory_save", "turn_sync", "checklist", "commitment"] as const;
export type WriteSurface = (typeof WRITE_SURFACES)[number];

export type WriteDecision = "would-write-place" | "would-write-none" | "same-as-today";

export function placeDecision(i: { place: PlaceRef; todaySource: string; agentId: string }): WriteDecision {
  if (i.todaySource !== agentSourceId(i.agentId)) return "same-as-today";
  return i.place.kind === "place" ? "would-write-place" : "would-write-none";
}

const loggedReasons = new Set<NoPlaceReason>();
/** Tests: forget which reasons were logged. */
export const __resetPlaceShadowForTests = (): void => loggedReasons.clear();

export function measureWrite(i: {
  surface: WriteSurface;
  place: PlaceRef;
  /** The source the write goes to today. */
  todaySource: string;
  agentId: string;
  log?: (line: string) => void;
}): void {
  try {
    if (env.memory.boundaries() === "off") return;
    const decision = placeDecision(i);
    m.memoryPlaceTotal.inc({ surface: i.surface, decision });
    if (decision !== "would-write-none" || i.place.kind !== "none") return;
    const reason = i.place.reason;
    m.memoryPlaceUnknownTotal.inc({ reason });
    if (!loggedReasons.has(reason)) {
      loggedReasons.add(reason);
      (i.log ?? ((l) => console.warn(l)))(`[memory] place unknown (${reason}); shadow only, no write changed (logged once per reason)`);
    }
  } catch {
    /* measuring never reaches a write */
  }
}
