/**
 * The registry side of memory places (rc.46): binding a place source to its (agent, boundary)
 * pair before the first write to it, and the check that a scope naming a place source names one
 * that is bound to THIS agent. Pure naming stays in ./place-id.ts; the rows are in
 * src/db/memory-scopes.ts. Answers are kept per process: a binding never changes, so a positive
 * answer is kept for good, a negative one for a few seconds (a place may be bound by a replica).
 *
 * Fails closed: a scope that names a place source with no agent, or one the registry does not
 * bind to that agent, is refused with a clear error. Nothing here falls back to persona-wide.
 */
import * as MemoryScopes from "../db/memory-scopes";
import type { BrainScope } from "../knowledge/scope";
import type { PlaceRef } from "./place";
import { hasPlacePrefix } from "./place-id";

const NEGATIVE_TTL_MS = 5_000;
const CAP = 20_000;

const bound = new Set<string>();
const absent = new Map<string, number>();
const keyOf = (agentId: string, source: string): string => `${agentId}\0${source}`;

const remember = (k: string): void => {
  if (bound.size >= CAP) bound.clear();
  bound.add(k);
  absent.delete(k);
};

/** Tests: forget every cached answer. */
export const __resetPlaceBindingForTests = (): void => {
  bound.clear();
  absent.clear();
};

export const PLACE_UNBOUND_ERROR = "memory place is not bound to this agent (refused: the place registry has no matching row)";

/**
 * Bind a place to its agent in the registry (insert-or-ignore) and say whether the registry now
 * holds exactly this source for the pair. False on any failure: the caller treats the place as
 * unknown (decision 3), never as readable without a binding.
 */
export async function bindPlace(agentId: string, place: Extract<PlaceRef, { kind: "place" }>): Promise<boolean> {
  const k = keyOf(agentId, place.source);
  if (bound.has(k)) return true;
  try {
    const held = await MemoryScopes.bindScope({ sourceId: place.source, agentId, boundaryId: place.boundaryId, kind: place.boundaryKind });
    if (held !== place.source) return false;
    remember(k);
    return true;
  } catch {
    return false;
  }
}

/** True when the registry binds this source to this agent. A failed read is false. */
export async function placeBound(agentId: string, source: string, now: () => number = Date.now): Promise<boolean> {
  const k = keyOf(agentId, source);
  if (bound.has(k)) return true;
  const miss = absent.get(k);
  if (miss !== undefined && now() - miss < NEGATIVE_TTL_MS) return false;
  try {
    const row = await MemoryScopes.lookupBySource(source);
    if (row && row.agent_id === agentId) {
      remember(k);
      return true;
    }
  } catch {
    /* an unreadable registry binds nothing */
  }
  if (absent.size >= CAP) absent.clear();
  absent.set(k, now());
  return false;
}

/** The place sources a scope names (write source and reads). */
export const placeSourcesOf = (scope: Pick<BrainScope, "sourceId" | "allowedSources">): string[] => [...new Set([scope.sourceId, ...scope.allowedSources].filter(hasPlacePrefix))];

/**
 * Throws unless every place source the scope names is bound to `scope.placeAgent` in the
 * registry. A scope with no place source passes without a read.
 */
export async function assertPlacesBound(scope: BrainScope): Promise<void> {
  const sources = placeSourcesOf(scope);
  if (sources.length === 0) return;
  if (!scope.placeAgent) throw new Error(PLACE_UNBOUND_ERROR);
  for (const s of sources) if (!(await placeBound(scope.placeAgent, s))) throw new Error(PLACE_UNBOUND_ERROR);
}

const ANY_TTL_MS = 30_000;
let anyAt = 0;
let anyAnswer = false;

/** Tests: forget the answer of anyPlaceBound. */
export const __resetAnyPlaceBoundForTests = (): void => {
  anyAt = 0;
  anyAnswer = false;
};

/**
 * True when the registry holds at least one place. With the mode `off` this is how a rollback
 * keeps reading the places written while it was `on`, while a deployment that never ran `on`
 * pays one cached read per 30 seconds and nothing else. A failed read is false.
 */
export async function anyPlaceBound(now: () => number = Date.now): Promise<boolean> {
  if (anyAnswer) return true; // a place is never unbound
  if (now() - anyAt < ANY_TTL_MS) return false;
  try {
    anyAnswer = (await MemoryScopes.anyBound()) === true;
  } catch {
    anyAnswer = false;
  }
  anyAt = now();
  return anyAnswer;
}
