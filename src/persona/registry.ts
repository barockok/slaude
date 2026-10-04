import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { WebClient } from "@slack/web-api";
import { env } from "../config/env";
import { paths } from "../config/home";
import type { Persona, PersonaConfig } from "./types";
import type { EffectivePersona } from "./effective";
import { effectivePersonas, isManaged, stateVersion } from "../db/personas";
import { resolveDbConfig } from "../db/client";
import { SoulDataSchema, type SoulData } from "../soul/data";
import { __resetSoulDataMemo, loadSoulData, setSoulData } from "../soul/extract";

export type { Persona, PersonaConfig };

export interface PersonaRegistry {
  lookupByUserId(slackUserId: string): Persona | null;
  lookupByName(name: string): Persona | null;
  list(): Persona[];
  isMultiPersonaMode(): boolean;
  /** True when this snapshot is a synced tenant's effective state (the
   *  database), false for the filesystem. A managed registry is complete: a
   *  persona it does not list is not live. */
  isManaged(): boolean;
  /** The retired (tombstoned) persona whose Slack identity this is, or null.
   *  Always null for a filesystem registry, and for an identity a live persona
   *  now holds. */
  tombstonedPersonaFor(slackUserId: string): string | null;
  /** Managed snapshots only: the `default` persona's effective model and mcp,
   *  or null when the tenant has no live `default` row. The default persona is
   *  not in `list()`. Absent on a filesystem registry. */
  defaultPersona?(): { model: string | null; mcp: unknown; runsOn?: string | null } | null;
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

    const slackApiUrl = env.slack.apiUrl();
    const outClient = config.userToken
      ? new WebClient(config.userToken, slackApiUrl ? { slackApiUrl } : undefined)
      : null;
    out.push({ name: entry, slackUserId: config.slackUserId, soulPath, config, outClient });
  }

  return out;
}

function snapshot(
  personas: Persona[],
  managed?: {
    tombstoned: Array<{ name: string; slackUserId: string }>;
    defaultPersona: { model: string | null; mcp: unknown; runsOn?: string | null } | null;
  },
): PersonaRegistry {
  const byUserId = new Map<string, Persona>(personas.map((p) => [p.slackUserId, p]));
  const byName = new Map<string, Persona>(personas.map((p) => [p.name, p]));
  const retired = new Map<string, string>(
    (managed?.tombstoned ?? []).filter((t) => !byUserId.has(t.slackUserId)).map((t) => [t.slackUserId, t.name]),
  );
  return {
    lookupByUserId: (id) => byUserId.get(id) ?? null,
    lookupByName: (name) => byName.get(name) ?? null,
    list: () => personas,
    isMultiPersonaMode: () => personas.length > 0,
    isManaged: () => managed !== undefined,
    tombstonedPersonaFor: (id) => retired.get(id) ?? null,
    ...(managed ? { defaultPersona: () => managed.defaultPersona } : {}),
  };
}

export function loadPersonaRegistry(): PersonaRegistry {
  return snapshot(loadPersonas());
}

export interface PersonaState {
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
  const everyRow = await effectivePersonas(tenant, { includeTombstoned: true });
  const all = everyRow.filter((p) => p.tombstonedAt === null);
  const tombstoned = everyRow
    .filter((p) => p.tombstonedAt !== null && p.slackUserId)
    .map((p) => ({ name: p.name, slackUserId: p.slackUserId! }));
  const slackApiUrl = env.slack.apiUrl();
  const personas: Persona[] = all
    .filter((p) => p.name !== "default" && p.slackUserId)
    .map((p) => ({
      name: p.name,
      slackUserId: p.slackUserId!,
      soulMd: p.soulMd,
      config: { slackUserId: p.slackUserId!, name: p.name, ...(p.userToken ? { userToken: p.userToken } : {}) },
      outClient: p.userToken ? new WebClient(p.userToken, slackApiUrl ? { slackApiUrl } : undefined) : null,
      model: p.model,
      mcp: p.mcp ?? null,
      runsOn: p.runsOn ?? null,
    }));
  const def = all.find((p) => p.name === "default") ?? null;
  const defaultFields = def ? { model: def.model, mcp: def.mcp ?? null, runsOn: def.runsOn ?? null } : null;
  return { registry: snapshot(personas, { tombstoned, defaultPersona: defaultFields }), managed: { defaultPersona: def } };
}

export async function buildPersonaRegistry(tenant: string): Promise<PersonaRegistry> {
  return (await loadPersonaState(tenant)).registry;
}

let stateLoader: (tenant: string) => Promise<PersonaState> = loadPersonaState;
let diskSoulDataLoader: () => Promise<SoulData> = loadSoulData;

/** Test seam: replace how a rebuild reads the tenant's state (null restores). */
export function __setPersonaStateLoader(f: ((tenant: string) => Promise<PersonaState>) | null) {
  stateLoader = f ?? loadPersonaState;
}

/** Test seam: replace the disk structured-soul read (null restores). */
export function __setDiskSoulDataLoader(f: (() => Promise<SoulData>) | null) {
  diskSoulDataLoader = f ?? loadSoulData;
}

let registry: PersonaRegistry | null = null;
/** Bumped on every install; a rebuild that started before a newer install
 *  discards its result instead of overwriting fresher state. */
let generation = 0;
let inflight: Promise<void> | null = null;
let managedDefaultSoul: string | null = null;
/** Whether the installed default soul pair came from a managed `default` row. */
let defaultPairFromDb = false;

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
  notifyInstalled(r);
}

/**
 * Listeners told of every installed snapshot (boot, reload signal, poll, and
 * setPersonaRegistry). The agent manager closes warm sessions of personas no
 * longer live; the gateway drops or re-points their routes. A listener that
 * throws is logged and never blocks the install or the other listeners.
 */
const installListeners = new Set<(r: PersonaRegistry) => void>();
export function onPersonaRegistryInstalled(fn: (r: PersonaRegistry) => void): () => void {
  installListeners.add(fn);
  return () => { installListeners.delete(fn); };
}
function notifyInstalled(r: PersonaRegistry) {
  for (const fn of [...installListeners]) {
    try {
      fn(r);
    } catch (e) {
      console.error("[persona] registry install listener failed:", (e as Error).message);
    }
  }
}

/** A named persona a managed registry does not list (retired or removed). */
export class PersonaNotLiveError extends Error {
  constructor(readonly persona: string) {
    super(`persona '${persona}' is not live on this tenant (retired or removed); refusing to act as the default persona`);
  }
}

/**
 * The live persona `name`, or null when an UNMANAGED (filesystem) registry does
 * not list it — the long-standing fallback to the default persona. A managed
 * registry is complete, so a name it does not list throws PersonaNotLiveError:
 * defaulting would hand a retired persona's thread the default's identity,
 * credentials and brain slice.
 */
export function livePersona(name: string, r: PersonaRegistry = getPersonaRegistry()): Persona | null {
  const p = r.lookupByName(name);
  if (p) return p;
  if (r.isManaged()) throw new PersonaNotLiveError(name);
  return null;
}

/**
 * The model a session of persona `name` (undefined = the default persona)
 * defaults to on a MANAGED tenant: its effective model — the git value or a
 * runtime override — or null when it sets none (the caller falls back to
 * SLAUDE_MODEL). Undefined on a filesystem registry, where personas carry no
 * model and a session keeps the model its row was created with.
 */
export function managedPersonaModel(name: string | undefined, r: PersonaRegistry = getPersonaRegistry()): string | null | undefined {
  if (!r.isManaged()) return undefined;
  if (!name || name === "default") return r.defaultPersona?.()?.model ?? null;
  return r.lookupByName(name)?.model ?? null;
}

/**
 * The node label persona `personaId` runs on (node labels spec §4.5). Signed
 * into the job token and payload at dispatch; the /v1 gate requires it among
 * the calling node's labels. A managed persona's `runs_on`, or "default" when it
 * sets none; a filesystem (or sqlite) persona has no row and is always
 * "default", as is a name the snapshot does not list.
 */
export function runsOnFor(personaId: string | undefined, r: PersonaRegistry = getPersonaRegistry()): string {
  if (!r.isManaged()) return "default";
  const label = !personaId || personaId === "default" ? r.defaultPersona?.()?.runsOn : r.lookupByName(personaId)?.runsOn;
  return label ?? "default";
}

/**
 * Build the tenant's state and install it: the registry snapshot, plus the
 * default persona's soul pair — its text and its structured soul, always from
 * one source, so approvals and ACLs never disagree with the soul in the prompt:
 *  - a managed `default` row: both from the row;
 *  - none (unmanaged, or no live `default` row): both from disk. Only a switch
 *    away from the row reloads them; boot already set the disk pair;
 *  - a row whose structure fails validation: the previous pair stays (neither
 *    half is installed), while the rest of the snapshot still installs.
 * Boot, the reload signal and the poll all go through here, so they cannot
 * drift. Resolves true only when this call installed a snapshot; false when a
 * newer rebuild superseded it.
 */
export async function refreshPersonaState(tenant: string): Promise<boolean> {
  const ticket = ++generation;
  const state = await stateLoader(tenant);
  let pair: { text: string | null; data: SoulData; fromDb: boolean } | null = null;
  const def = state.managed?.defaultPersona ?? null;
  if (def) {
    const parsed = SoulDataSchema.safeParse(def.soulJson);
    if (parsed.success) pair = { text: def.soulMd, data: parsed.data, fromDb: true };
    else console.error(`[persona] the default persona's soul structure is invalid tenant=${tenant}; keeping the previous default soul`);
  } else if (defaultPairFromDb) {
    pair = { text: null, data: await diskSoulDataLoader(), fromDb: false };
  }
  if (ticket !== generation) return false; // a newer install won
  registry = state.registry;
  if (pair) {
    managedDefaultSoul = pair.text;
    setSoulData(pair.data);
    defaultPairFromDb = pair.fromDb;
  }
  notifyInstalled(state.registry);
  return true;
}

/**
 * A reload signal. The current snapshot keeps serving — dropping it would make
 * the next access lazily rebuild from disk, flipping a managed tenant onto the
 * filesystem — while a rebuild from the tenant's source runs in the background.
 * Synchronous to callers; a failed rebuild is logged and the snapshot stays.
 */
export function invalidatePersonaRegistry() {
  const run = refreshPersonaState("default").then(
    () => {},
    (e) => { console.warn("[persona] registry rebuild failed:", (e as Error).message); },
  );
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
      // Record the version only when this rebuild installed it: a superseded
      // one installed nothing, and the rebuild that superseded it may fail.
      if (await refreshPersonaState(tenant)) last = v;
    } catch (e) {
      console.warn("[persona] registry revalidation failed:", (e as Error).message);
    } finally {
      running = false;
    }
  }, everyMs);
  t.unref?.();
  return () => clearInterval(t);
}

/** Test helper: forget every installed snapshot, in-flight rebuild and default
 *  soul pair, including the structured-soul memo the pair writes into. */
export function __resetPersonaRegistry() {
  __resetSoulDataMemo();
  generation++;
  registry = null;
  inflight = null;
  managedDefaultSoul = null;
  defaultPairFromDb = false;
  stateLoader = loadPersonaState;
  diskSoulDataLoader = loadSoulData;
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
