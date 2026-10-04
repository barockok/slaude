/**
 * Per-persona knowledge scope (WS-C §4.1). A persona's `kbSources` narrows the
 * `kb-*` sources it may read:
 *
 *   absent / null   every installed KB (the behaviour before the field)
 *   []              none
 *   [a, b]          those, intersected with what is installed
 *
 * It governs only the `kb-*` sources; the caller's own slice, `shared`,
 * `public` and the legacy `agent` source keep their own rules (scope.ts).
 * Computed per call from the live persona, so a sync takes effect on the next
 * turn.
 *
 * This filters RETRIEVAL. It is not isolation: the KB files sit on the shared
 * volume, and personas on one node share a trust domain.
 */
import { loadKbs, type KbEntry } from "./loader";
import { kbSourceId } from "./scope";
import { getPersonaRegistry, livePersona, type PersonaRegistry } from "../persona/registry";

/** Source ids of every installed KB, in install (directory) order. */
export function installedKbSourceIds(): string[] {
  return loadKbs().map((k) => kbSourceId(k.label));
}

/**
 * The persona's own `kbSources` list, or null for "all installed": always null
 * on a filesystem registry. A named persona a managed registry does not list
 * throws (livePersona), so a retired persona's thread reads no KB at all.
 */
export function personaKbList(personaId: string | undefined, r: PersonaRegistry = getPersonaRegistry()): string[] | null {
  if (!r.isManaged()) return null;
  if (!personaId || personaId === "default") return r.defaultPersona?.()?.kbSources ?? null;
  return livePersona(personaId, r)?.kbSources ?? null;
}

/** The installed KBs this persona may read (the list ∩ installed). */
export function personaKbs(personaId: string | undefined, r?: PersonaRegistry): KbEntry[] {
  const list = personaKbList(personaId, r);
  const kbs = loadKbs();
  if (list === null) return kbs;
  const allowed = new Set(list);
  return kbs.filter((k) => allowed.has(kbSourceId(k.label)));
}

/** The `kb-*` source ids this persona may read, for resolveBrainScope. */
export function personaKbSourceIds(personaId: string | undefined, r?: PersonaRegistry): string[] {
  return personaKbs(personaId, r).map((k) => kbSourceId(k.label));
}
