import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/home";
import type { Persona, PersonaConfig } from "./types";

export type { Persona, PersonaConfig };

export interface PersonaRegistry {
  lookupByUserId(slackUserId: string): Persona | null;
  lookupByName(name: string): Persona | null;
  list(): Persona[];
  isMultiPersonaMode(): boolean;
}

function loadPersonas(): Persona[] {
  const root = paths.personas;
  if (!existsSync(root)) return [];

  const out: Persona[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const dir = join(root, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }

    const configPath = join(dir, "config.json");
    const soulPath = join(dir, "SOUL.md");

    if (!existsSync(configPath) || !existsSync(soulPath)) {
      console.warn(`[persona] skipping ${entry}: missing config.json or SOUL.md`);
      continue;
    }

    let config: PersonaConfig;
    try {
      config = JSON.parse(readFileSync(configPath, "utf8")) as PersonaConfig;
      if (!config.slackUserId || typeof config.slackUserId !== "string") {
        throw new Error("missing slackUserId");
      }
    } catch (e) {
      console.warn(`[persona] skipping ${entry}: invalid config.json —`, e);
      continue;
    }

    out.push({ name: entry, slackUserId: config.slackUserId, soulPath, config });
  }

  return out;
}

export function loadPersonaRegistry(): PersonaRegistry {
  const personas = loadPersonas();
  const byUserId = new Map<string, Persona>(personas.map((p) => [p.slackUserId, p]));
  const byName = new Map<string, Persona>(personas.map((p) => [p.name, p]));

  return {
    lookupByUserId: (id) => byUserId.get(id) ?? null,
    lookupByName: (name) => byName.get(name) ?? null,
    list: () => personas,
    isMultiPersonaMode: () => personas.length > 0,
  };
}

let registry: PersonaRegistry | null = null;

export function setPersonaRegistry(r: PersonaRegistry) {
  registry = r;
}

export function getPersonaRegistry(): PersonaRegistry {
  if (!registry) {
    // Lazy init for call sites that run before server boot (e.g. tests).
    registry = loadPersonaRegistry();
  }
  return registry;
}
