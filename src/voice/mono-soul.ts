/**
 * The soul a mono voice call speaks with: the thread persona's, as the manager
 * boots that persona's session (personaSoulText; a managed registry refuses a
 * retired persona), with the channel's mandate override applied. Mono only:
 * a node takes the soul from its runtime bundle.
 */
import { cachedSoulData, effectiveSoulForChannel } from "../soul/extract";
import { personaSoulText } from "../persona/soul-source";
import { livePersona } from "../persona/registry";

/** Null when the persona cannot be resolved (retired or unknown): the caller
 *  refuses the call rather than speak as another persona. */
export function monoPersonaSoul(personaId: string | null | undefined, channelId: string): unknown | null {
  if (!personaId || personaId === "default") return effectiveSoulForChannel(channelId);
  try {
    const p = livePersona(personaId);
    if (!p) return null;
    // Structured data exists once the persona's soul was extracted (persona
    // sync does); otherwise the voice at least carries the persona's name.
    const data = cachedSoulData(personaSoulText(personaId));
    if (!data) return { identity: { name: p.name }, values: [] };
    const ov = data.channelOverrides.find((c) => c.channel === channelId);
    return ov?.mandate?.trim() ? { ...data, mandate: ov.mandate } : data;
  } catch (e) {
    console.warn(`[voice] persona soul unavailable persona=${personaId}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
