/**
 * Which agent may use which shared environment: the persona's own
 * `environment.allow` list, read from the stored persona (never from a cache a
 * warm process holds), and nothing else. A persona with no `environment:` key
 * is allowed no shared environment. Anything that throws is a refusal, decided
 * by the caller.
 */
import { personaByName } from "../../db/personas";

/** The shared environment names a persona allows (without the `env:` prefix); empty when it declares none. */
export async function allowedEnvironments(tenant: string, persona: string): Promise<string[]> {
  const row = await personaByName(tenant, persona);
  return row?.effective.definition?.environment?.allow ?? [];
}

export type AllowLookup = (tenant: string, persona: string) => Promise<string[]>;
