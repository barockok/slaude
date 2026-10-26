import { env } from "../config/env";
import { getPersonaRegistry } from "../persona/registry";
import { isValidTimeZone } from "../persona/sync/payload";
import type { BudgetConfig } from "./budget";

const warned = new Set<string>();

/** Test seam: forget which personas already got a timezone warning. */
export function __resetBackgroundConfigWarnings(): void {
  warned.clear();
}

/**
 * The budget and day-boundary timezone for a persona's background passes.
 * Persona `background` values win over the environment (budget), which wins
 * over the defaults (1 USD, UTC). A timezone `localDay` would reject falls back
 * to UTC with one warning per persona per process, so a bad value never makes
 * a pass throw.
 */
export function budgetConfigFor(personaId: string): BudgetConfig {
  const reg = getPersonaRegistry();
  const bg = personaId === "default" ? reg.defaultPersona?.()?.background : reg.lookupByName(personaId)?.background;
  const limitUsd = bg?.budgetUsd ?? env.backgroundBudgetUsd();
  let timeZone = bg?.timezone ?? "UTC";
  if (!isValidTimeZone(timeZone)) {
    if (!warned.has(personaId)) {
      warned.add(personaId);
      console.warn(`[background] persona=${personaId}: invalid timezone '${timeZone.slice(0, 64)}'; using UTC`);
    }
    timeZone = "UTC";
  }
  return { limitUsd, timeZone };
}
