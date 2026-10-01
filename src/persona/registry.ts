import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { WebClient } from "@slack/web-api";
import { paths } from "../config/home";
import type { Persona, PersonaConfig } from "./types";
import type { EffectivePersona } from "./effective";
import { effectivePersonas, isManaged, stateVersion } from "../db/personas";
import { resolveDbConfig } from "../db/client";
import { SoulDataSchema } from "../soul/data";
import { setSoulData } from "../soul/extract";

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

    const outClient = config.userToken ? new WebClient(config.userToken) : null;
    out.push({ name: entry, slackUserId: config.slackUserId, soulPath, config, outClient });
  }

  return out;
}

function snapshot(personas: Persona[]): PersonaRegistry {
  const byUserId = new Map<string, Persona>(personas.map((p) => [p.slackUserId, p]));
  const byName = new Map<string, Persona>(personas.map((p) => [p.name, p]));
  return {
    lookupByUserId: (id) => byUserId.get(id) ?? null,
    lookupByName: (name) => byName.get(name) ?? null,
    list: () => personas,
    isMultiPersonaMode: () => personas.length > 0,
  };
}

export function loadPersonaRegistry(): PersonaRegistry {
  return snapshot(loadPersonas());
}

interface PersonaState {
  registry: PersonaRegistry;
  /** Null when the tenant has never been synced: it reads the filesystem. */
  managed: { defaultPersona: EffectivePersona | null } | null;
}

/**
 * One source per tenant, never a merge: a tenant that has never been synced
 * reads the filesystem exactly as before; the first sync flips it to effective
 * state from the database. Tombstoned personas are excluded, so their Slack
 * identity stops routing while their rows stay intact. The default persona is
 * not in the snapshot — its soul is served by `personaSoulText()`.
 *
 * sqlite has no persona tables, so it is always the filesystem, decided from
 * configuration rather than from a failed query. On Postgres a failed read
 * throws: falling back to the filesystem on a transient error would flip a
 * managed tenant onto a source it no longer uses.
 */
async function loadPersonaState(tenant: string): Promise<PersonaState> {
  if (resolveDbConfig().dialect === "sqlite" || !(await isManaged(tenant))) {
    return { registry: loadPersonaRegistry(), managed: null };
  }
  const all = await effectivePersonas(tenant);
  const personas: Persona[] = all
    .filter((p) => p.name !== "default" && p.slackUserId)
    .map((p) => ({
      name: p.name,
      slackUserId: p.slackUserId!,
      soulMd: p.soulMd,
      config: { slackUserId: p.slackUserId!, name: p.name, ...(p.userToken ? { userToken: p.userToken } : {}) },
      outClient: p.userToken ? new WebClient(p.userToken) : null,
    }));
  return { registry: snapshot(personas), managed: { defaultPersona: all.find((p) => p.name === "default") ?? null } };
}

export async function buildPersonaRegistry(tenant: string): Promise<PersonaRegistry> {
  return (await loadPersonaState(tenant)).registry;
}

let registry: PersonaRegistry | null = null;
/** Bumped on every install; a rebuild that started before a newer install
 *  discards its result instead of overwriting fresher state. */
let generation = 0;
let inflight: Promise<void> | null = null;
let managedDefaultSoul: string | null = null;

/** The managed `default` persona's soul text, or null when the tenant is not
 *  managed or has no `default` row (then the global SOUL.md is the soul). */
export function getManagedDefaultSoul(): string | null {
  return managedDefaultSoul;
}

export function setManagedDefaultSoul(s: string | null) {
  managedDefaultSoul = s;
}

export function setPersonaRegistry(r: PersonaRegistry) {
  generation++;
  registry = r;
}

/**
 * Build the tenant's state and install it: the registry snapshot, and for a
 * managed tenant the default persona's soul text and structured soul, so a sync
 * that changes the default persona reaches approvals and ACLs too. Boot, the
 * reload signal and the poll all go through here, so they cannot drift.
 */
export async function refreshPersonaState(tenant: string): Promise<void> {
  const ticket = ++generation;
  const state = await loadPersonaState(tenant);
  if (ticket !== generation) return; // a newer install won
  registry = state.registry;
  if (!state.managed) {
    managedDefaultSoul = null;
    return;
  }
  const def = state.managed.defaultPersona;
  managedDefaultSoul = def ? def.soulMd : null;
  if (def?.soulJson) {
    try {
      setSoulData(SoulDataSchema.parse(def.soulJson));
    } catch (e) {
      console.warn("[persona] managed default soul structure is invalid:", (e as Error).message);
    }
  }
}

/**
 * A reload signal. The current snapshot keeps serving — dropping it would make
 * the next access lazily rebuild from disk, flipping a managed tenant onto the
 * filesystem — while a rebuild from the tenant's source runs in the background.
 * Synchronous to callers; a failed rebuild is logged and the snapshot stays.
 */
export function invalidatePersonaRegistry() {
  const run = refreshPersonaState("default").catch((e) => {
    console.warn("[persona] registry rebuild failed:", (e as Error).message);
  });
  const tracked: Promise<void> = run.finally(() => {
    if (inflight === tracked) inflight = null;
  });
  inflight = tracked;
}

/** Resolves once the most recent background rebuild has finished. */
export async function whenPersonaRegistrySettled(): Promise<void> {
  while (inflight) await inflight;
}

/** Rebuild the snapshot whenever the tenant's state version changes. The reload
 *  signal makes this faster; the poll makes it certain. */
export function startRegistryRevalidation(tenant: string, everyMs = 10_000): () => void {
  let last: string | null = null;
  let running = false;
  const t = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const v = await stateVersion(tenant);
      if (v === last) return;
      await refreshPersonaState(tenant);
      last = v;
    } catch (e) {
      console.warn("[persona] registry revalidation failed:", (e as Error).message);
    } finally {
      running = false;
    }
  }, everyMs);
  t.unref?.();
  return () => clearInterval(t);
}

/** Test helper: forget every installed snapshot and in-flight rebuild. */
export function __resetPersonaRegistry() {
  generation++;
  registry = null;
  inflight = null;
  managedDefaultSoul = null;
}

/**
 * The installed snapshot. Lazy init loads the filesystem ONLY when nothing has
 * been installed yet (tests, call sites that run before boot); once a snapshot
 * is installed it is never dropped, so this never falls back to disk.
 */
export function getPersonaRegistry(): PersonaRegistry {
  if (!registry) registry = loadPersonaRegistry();
  return registry;
}
