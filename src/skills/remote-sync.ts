/**
 * Runtime skills over an S3-compatible store (SLAUDE_STORAGE=s3).
 *
 * Scope is runtime-evolved skills only: what write_skill, delete, retire and
 * restore change while the agent runs. Plugin skills, bundled skills and
 * skills installed from slaude.lock ship in the image and are identical on
 * every pod; a runtime write to one of those slugs is an overlay that shadows
 * it everywhere.
 *
 * The store is authoritative and every process mirrors it into its own local
 * skills directories, which is where the loader and the agent SDK already read:
 *
 *   shared/skills/<scope>/<slug>/<version>/<file>   immutable skill versions
 *   shared/skills-head/<scope>/<slug>.json          the current version, or a tombstone
 *
 * A change is pushed (files first, head last), then announced on the
 * skills-changed channel; each process refetches that one skill and swaps it
 * in with a rename. A missed message is repaired by `pullAll`, which every turn
 * runs and which costs one list call when nothing changed. Two writers racing
 * on one slug resolve to the head written last.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { paths } from "../config/home";
import { m as metric } from "../metrics";
import { getText, putText, syncStateDir, type ObjectStore } from "../storage";
import { SKILL_SLUG_RE, globalSkillsRoot, personaSkillsRoot } from "./loader";
import { bundledSkillPath } from "./seed";

export const GLOBAL_SCOPE = "global";
const SCOPE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEAD_PREFIX = "shared/skills-head/";

interface Head {
  version: string;
  deleted: boolean;
  files: string[];
  at: number;
}

export type PullResult = "updated" | "deleted" | "current" | "missing" | "refused";

/** `undefined` and `default` are the shared base; any other persona name is its own scope. */
export const scopeOf = (personaName?: string): string => (personaName && personaName !== "default" ? personaName : GLOBAL_SCOPE);

const validScope = (s: string): boolean => s === GLOBAL_SCOPE || (SCOPE_RE.test(s) && s !== "." && s !== "..");

/** Where a scope's skill lives on this machine. */
export function skillDirFor(scope: string, slug: string): string {
  return join(scope === GLOBAL_SCOPE ? globalSkillsRoot() : personaSkillsRoot(scope), slug);
}

const headKey = (scope: string, slug: string): string => `${HEAD_PREFIX}${scope}/${slug}.json`;
const fileKey = (scope: string, slug: string, version: string, rel: string): string => `shared/skills/${scope}/${slug}/${version}/${rel}`;

interface SyncState {
  versions: Record<string, string>;
}

/** Beside the node's other sync state when SLAUDE_SYNC_STATE_DIR is set, else under $SLAUDE_HOME as before. */
const defaultStateFile = (): string => {
  const dir = syncStateDir();
  return dir ? join(dir, "skills-sync.json") : join(paths.home, ".skills-sync.json");
};

function readState(file: string): SyncState {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as SyncState;
    if (v && typeof v.versions === "object") return v;
  } catch {
    /* first run, or unreadable: start empty */
  }
  return { versions: {} };
}

function writeState(file: string, s: SyncState): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(s));
  renameSync(tmp, file);
}

function walkFiles(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkFiles(root, r));
    else if (e.isFile()) out.push(r);
  }
  return out.sort();
}

const newVersion = (): string => `${String(Date.now()).padStart(15, "0")}-${randomBytes(3).toString("hex")}`;

export interface SyncOpts {
  stateFile?: string;
  now?: () => number;
}

/** Publish this machine's copy of a skill: files first, then the head. A missing local directory publishes a tombstone. */
export async function pushSkill(store: ObjectStore, scope: string, slug: string, opts: SyncOpts = {}): Promise<{ version: string; deleted: boolean }> {
  if (!validScope(scope) || !SKILL_SLUG_RE.test(slug)) throw new Error(`refusing to sync skill ${scope}/${slug}: unsafe name`);
  const dir = skillDirFor(scope, slug);
  const version = newVersion();
  const at = (opts.now ?? Date.now)();
  const live = existsSync(join(dir, "SKILL.md"));
  const files = live ? walkFiles(dir) : [];
  for (const rel of files) await store.put(fileKey(scope, slug, version, rel), Bun.file(join(dir, rel)));
  const head: Head = { version, deleted: !live, files, at };
  await putText(store, headKey(scope, slug), JSON.stringify(head));
  const sf = opts.stateFile ?? defaultStateFile();
  const st = readState(sf);
  st.versions[`${scope}/${slug}`] = version;
  writeState(sf, st);
  return { version, deleted: !live };
}

/** Bring this machine's copy of one skill to the store's head. Atomic for a reader: the directory is swapped by rename. */
export async function pullSkill(store: ObjectStore, scope: string, slug: string, opts: SyncOpts = {}): Promise<PullResult> {
  if (!validScope(scope) || !SKILL_SLUG_RE.test(slug)) return "refused";
  const text = await getText(store, headKey(scope, slug));
  if (text === null) return "missing";
  let head: Head;
  try {
    head = JSON.parse(text) as Head;
  } catch {
    return "refused";
  }
  const sf = opts.stateFile ?? defaultStateFile();
  const st = readState(sf);
  const key = `${scope}/${slug}`;
  if (st.versions[key] === head.version) return "current";
  // An edit made here that has not reached the store yet (the store was down, or the push is in flight)
  // is newer than the head: pulling now would replace it with an older version and lose it.
  if (dirty.has(key)) return "current";
  const dir = skillDirFor(scope, slug);

  if (head.deleted) {
    rmSync(dir, { recursive: true, force: true });
    // A bundled skill the agent had overlaid or deleted comes back from the release.
    if (scope === GLOBAL_SCOPE && existsSync(join(bundledSkillPath(slug), "SKILL.md"))) cpSync(bundledSkillPath(slug), dir, { recursive: true });
    st.versions[key] = head.version;
    writeState(sf, st);
    return "deleted";
  }

  mkdirSync(dirname(dir), { recursive: true });
  const tmp = `${dir}.pull-${randomBytes(4).toString("hex")}`;
  try {
    for (const rel of head.files) {
      if (rel === "" || rel.startsWith("/") || rel.split("/").some((s) => s === ".." || s === "." || s === "")) throw new Error(`unsafe path in skill head: ${rel}`);
      const body = await store.get(fileKey(scope, slug, head.version, rel));
      if (!body) throw new Error(`skill file ${rel} of ${key}@${head.version} is missing from the store`);
      const dest = join(tmp, rel);
      mkdirSync(dirname(dest), { recursive: true });
      await pipeline(Readable.fromWeb(body as never), createWriteStream(dest));
    }
    if (!existsSync(join(tmp, "SKILL.md"))) throw new Error(`skill ${key}@${head.version} has no SKILL.md`);
    const old = existsSync(dir) ? `${dir}.old-${randomBytes(4).toString("hex")}` : null;
    if (old) renameSync(dir, old);
    renameSync(tmp, dir);
    if (old) rmSync(old, { recursive: true, force: true });
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    metric.storageRequestErrorsTotal.inc({ op: "get" });
    throw e;
  }
  st.versions[key] = head.version;
  writeState(sf, st);
  return "updated";
}

/** Reconcile every skill the store knows about. One list call when nothing changed since `seen`. */
export async function pullAll(
  store: ObjectStore,
  opts: SyncOpts & { seen?: Map<string, string>; onPulled?: (scope: string, slug: string, r: PullResult) => void } = {},
): Promise<{ updated: number; deleted: number }> {
  const seen = opts.seen ?? new Map<string, string>();
  let updated = 0;
  let deleted = 0;
  for await (const o of store.list(HEAD_PREFIX)) {
    if (seen.get(o.key) === o.etag) continue;
    const m = /^shared\/skills-head\/([^/]+)\/([^/]+)\.json$/.exec(o.key);
    if (!m) continue;
    const [, scope, slug] = m as unknown as [string, string, string];
    try {
      const r = await pullSkill(store, scope, slug, opts);
      seen.set(o.key, o.etag);
      if (r === "updated") updated++;
      if (r === "deleted") deleted++;
      if (r === "updated" || r === "deleted") opts.onPulled?.(scope, slug, r);
    } catch (e) {
      console.error(`[skills] could not refresh ${scope}/${slug}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { updated, deleted };
}

/** The hook the skill tools call after a local change; installed by whichever process owns the store and the bus. */
let remote: ((scope: string, slug: string) => Promise<void>) | null = null;

/** Local skill changes the store has not accepted yet (`scope/slug`). They are retried before every refresh and never overwritten by a pull. */
const dirty = new Set<string>();

export function setSkillRemote(fn: ((scope: string, slug: string) => Promise<void>) | null): void {
  remote = fn;
  if (!fn) dirty.clear();
}

/** Push one local change, tracking it as unpublished until the store has it. */
async function publish(fn: (scope: string, slug: string) => Promise<void>, scope: string, slug: string): Promise<void> {
  const key = `${scope}/${slug}`;
  dirty.add(key);
  try {
    await fn(scope, slug);
    dirty.delete(key);
  } catch (e) {
    metric.storageRequestErrorsTotal.inc({ op: "put" });
    console.error(`[skills] could not publish ${key}: ${e instanceof Error ? e.message : String(e)} (will retry)`);
  }
}

/** Retry every change the store has not accepted. Called before each refresh. */
export async function retryUnpublishedSkills(): Promise<void> {
  const fn = remote;
  if (!fn) return;
  for (const key of [...dirty]) {
    const i = key.indexOf("/");
    await publish(fn, key.slice(0, i), key.slice(i + 1));
  }
}

/** Fire and forget: the local change already happened and must not wait on, or fail because of, the store. */
export function notifySkillRemote(personaName: string | undefined, slug: string): void {
  const fn = remote;
  if (!fn) return;
  void publish(fn, scopeOf(personaName), slug);
}

export interface SkillBus {
  publishSkillChanged(payload: string): Promise<number>;
  onSkillChanged(cb: (payload: string) => void): Promise<() => Promise<void>>;
}

export interface SkillMirror {
  /** Reconcile with the store now (every turn calls this). */
  refresh(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Install push and pull for this process: the tool hook publishes, the channel
 * subscription pulls, and an initial pullAll catches up a fresh pod.
 */
export async function startSkillMirror(deps: {
  store: ObjectStore;
  bus: SkillBus;
  opts?: SyncOpts;
  onPulled?: (scope: string, slug: string, r: PullResult) => void;
}): Promise<SkillMirror> {
  const { store, bus } = deps;
  const seen = new Map<string, string>();
  const o = deps.opts ?? {};
  setSkillRemote(async (scope, slug) => {
    const r = await pushSkill(store, scope, slug, o);
    await bus.publishSkillChanged(JSON.stringify({ scope, slug, version: r.version, at: (o.now ?? Date.now)() }));
  });
  const unsub = await bus.onSkillChanged((payload) => {
    void (async () => {
      let msg: { scope?: string; slug?: string; at?: number };
      try {
        msg = JSON.parse(payload);
      } catch {
        return;
      }
      if (!msg.scope || !msg.slug) return;
      try {
        const r = await pullSkill(store, msg.scope, msg.slug, o);
        if (r === "updated" || r === "deleted") {
          if (typeof msg.at === "number") metric.skillsInvalidationLag.observe(Math.max(0, ((o.now ?? Date.now)() - msg.at) / 1000));
          deps.onPulled?.(msg.scope, msg.slug, r);
        }
      } catch (e) {
        console.error(`[skills] could not refresh ${msg.scope}/${msg.slug}: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  });
  const refresh = async (): Promise<void> => {
    try {
      await retryUnpublishedSkills();
      await pullAll(store, { ...o, seen, ...(deps.onPulled ? { onPulled: deps.onPulled } : {}) });
    } catch (e) {
      console.error(`[skills] refresh failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  await refresh();
  return {
    refresh,
    stop: async () => {
      setSkillRemote(null);
      await unsub().catch(() => {});
    },
  };
}
