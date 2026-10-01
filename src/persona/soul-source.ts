/**
 * The one place soul text is read from on the gateway and in mono.
 * Named persona: its database soul when managed, else its file. Default persona:
 * the managed `default` row when one exists, else $SLAUDE_HOME/SOUL.md.
 *
 * The managed default soul is installed by the registry's rebuild (boot, the
 * reload signal, the poll), so it lives beside the snapshot it belongs to.
 */
import { loadSoul } from "../soul/loader";
import { getManagedDefaultSoul, getPersonaRegistry, setManagedDefaultSoul } from "./registry";

export { setManagedDefaultSoul };

export function personaSoulText(name?: string): string {
  if (name && name !== "default") {
    const p = getPersonaRegistry().lookupByName(name);
    if (p?.soulMd !== undefined) return p.soulMd;
    if (p?.soulPath) return loadSoul(p.soulPath);
  }
  return getManagedDefaultSoul() ?? loadSoul();
}
