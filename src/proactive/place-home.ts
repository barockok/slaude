/**
 * Where a channel's checklist, commitments and rules live once memory places are on (rc.46): the
 * place of the channel the work is in, as a brain scope the proactive code reads and writes through.
 * Background code has no turn gate, so it asks here: which place is this (agent, channel), is it
 * active for this persona, and can it be bound in the registry.
 *
 *  - `on` for the persona and the place binds: the home is the place (`scope` set, `on` true);
 *  - not `on` (mode off or shadow, or a persona outside the canary) but the place was bound while
 *    the flag was on: `scope` is set and `on` false, so a rollback keeps reading what was written
 *    there (decision 7), while writes stay where rc.45 puts them;
 *  - anything else (no place, never bound): `scope` null, rc.45 behaviour.
 * Never throws: a failure is "no place".
 */
import { env } from "../config/env";
import type { BrainScope } from "../knowledge/scope";
import { placeFor, type PlaceInput, type PlaceRef } from "../memory/place";
import { bindPlace, placeBound } from "../memory/place-binding";

export interface PlaceHomeDeps {
  place?: (i: PlaceInput) => Promise<PlaceRef>;
  placesOn?: (persona: string | null | undefined) => boolean;
}

export interface PlaceHome {
  /** True when memory places are active for this persona (writes go to the place when `scope` is set). */
  on: boolean;
  /** The place as a scope (write source and only read), or null. */
  scope: BrainScope | null;
}

export const placeScopeFor = (agentId: string, source: string): BrainScope => ({ clientId: agentId, sourceId: source, allowedSources: [source], placeAgent: agentId });

export async function placeHome(i: { agentId: string; personaId: string | null | undefined; teamId: string | null | undefined; channel: string | null | undefined }, deps: PlaceHomeDeps = {}): Promise<PlaceHome> {
  const on = (deps.placesOn ?? ((p) => env.memory.placesOn(p)))(i.personaId ?? "default");
  try {
    if (!i.channel) return { on, scope: null };
    const ref = await (deps.place ?? placeFor)({ agentId: i.agentId, teamId: i.teamId ?? null, channel: i.channel, personaId: i.personaId && i.personaId !== "default" ? i.personaId : null });
    if (ref.kind !== "place") return { on, scope: null };
    const ok = on ? await bindPlace(i.agentId, ref) : await placeBound(i.agentId, ref.source);
    return { on, scope: ok ? placeScopeFor(i.agentId, ref.source) : null };
  } catch {
    return { on, scope: null };
  }
}
