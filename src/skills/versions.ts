/**
 * Skill version log: which content each skill on disk has had. Files stay the
 * runtime authority; the database only records what they were, so nothing here
 * can stop a skill from loading. Only a process with a database writes it
 * (mono, gateway; a node has none and does not reach this code).
 *
 * A skill's identity is its root plus its slug: the shared base is scope
 * `global` and a persona's overlay is scope `<persona>`. A new row is written
 * only when the content hash differs from the identity's latest row, so a
 * reconcile finding nothing changed writes nothing. Rows are never removed: a
 * retired skill or a deleted file keeps its history. A persona literally named
 * `global` is stored as `persona:global` (persona names have no `:`), so it
 * cannot share history with the base root.
 *
 * The hash covers every file under the skill's directory by relative path and
 * bytes in sorted order. Nothing is followed: a symlink counts by its target
 * text. A skill with an unreadable file is skipped for the pass rather than
 * recorded from partial data. Failures are logged by slug and error code only,
 * so no skill content reaches the log.
 */
import { createHash } from "node:crypto";
import { constants as fsc, existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { open, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../config/env";
import { paths } from "../config/home";
import * as SkillVersions from "../db/skill-versions";
import { globalSkillsRoot, parseSkillText, personaSkillsRoot, SKILL_MD_MAX_BYTES } from "./loader";
import { provenanceSources, skillProvenance, type ProvenanceSources } from "./provenance";

export const GLOBAL_SCOPE = "global";

/** The version-log scope of a persona's own root (undefined or `default`: the shared base). */
export function versionScope(personaName?: string | null): string {
  if (!personaName || personaName === "default") return GLOBAL_SCOPE;
  return personaName === GLOBAL_SCOPE ? `persona:${personaName}` : personaName;
}

/** Tool state in a skill's tree, not part of it: a git checkout's metadata, Python's bytecode cache. */
const IGNORED_DIRS = new Set([".git", "__pycache__"]);

export interface SkillFingerprint {
  hash: string;
  fileCount: number;
  totalBytes: number;
  /** SKILL.md text, cut at SKILL_MD_MAX_BYTES. */
  skillMd: string;
  truncated: boolean;
}

interface TreeEntry {
  rel: string;
  kind: "file" | "link";
}

async function listTree(dir: string, rel: string, out: TreeEntry[]): Promise<void> {
  for (const d of await readdir(rel ? join(dir, rel) : dir, { withFileTypes: true })) {
    const p = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) {
      if (!IGNORED_DIRS.has(d.name)) await listTree(dir, p, out);
    } else if (d.isSymbolicLink()) {
      out.push({ rel: p, kind: "link" });
    } else if (d.isFile()) {
      out.push({ rel: p, kind: "file" });
    }
    // A FIFO, socket or device is not skill content and is never opened.
  }
}

const READ_CHUNK = 64 * 1024;

/** Hash one regular file (no symlink, no blocking on a swapped-in FIFO), keeping up to `keep` bytes. */
async function readRegular(path: string, keep: number): Promise<{ digest: string; size: number; head: Buffer }> {
  const fh = await open(path, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
  try {
    if (!(await fh.stat()).isFile()) throw Object.assign(new Error("not a regular file"), { code: "ENOTREG" });
    const hash = createHash("sha256");
    const buf = Buffer.allocUnsafe(READ_CHUNK);
    const kept: Buffer[] = [];
    let size = 0;
    let keptBytes = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, READ_CHUNK, null);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
      if (keptBytes < keep) {
        const part = Buffer.from(buf.subarray(0, Math.min(bytesRead, keep - keptBytes)));
        kept.push(part);
        keptBytes += part.length;
      }
      size += bytesRead;
    }
    return { digest: hash.digest("hex"), size, head: Buffer.concat(kept) };
  } finally {
    await fh.close();
  }
}

/** Fingerprint a skill directory. Throws when any part of it cannot be read. */
export async function fingerprintSkill(dir: string): Promise<SkillFingerprint> {
  const entries: TreeEntry[] = [];
  await listTree(dir, "", entries);
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const tree = createHash("sha256");
  let totalBytes = 0;
  let skillMd: { head: Buffer; size: number } | null = null;
  for (const e of entries) {
    const abs = join(dir, e.rel);
    if (e.kind === "link") {
      const digest = createHash("sha256").update(await readlink(abs)).digest("hex");
      tree.update(`l\0${e.rel}\0${digest}\0`);
      continue;
    }
    const isSkillMd = e.rel === "SKILL.md";
    const r = await readRegular(abs, isSkillMd ? SKILL_MD_MAX_BYTES : 0);
    tree.update(`f\0${e.rel}\0${r.digest}\0`);
    totalBytes += r.size;
    if (isSkillMd) skillMd = { head: r.head, size: r.size };
  }
  if (!skillMd) throw Object.assign(new Error("SKILL.md is not a regular file"), { code: "ENOSKILLMD" });
  return {
    hash: tree.digest("hex"),
    fileCount: entries.length,
    totalBytes,
    // A NUL is valid in a file but not in a Postgres text column.
    skillMd: skillMd.head.toString("utf8").replaceAll("\0", "�"),
    truncated: skillMd.size > SKILL_MD_MAX_BYTES,
  };
}

type Repo = Pick<typeof SkillVersions, "latest" | "insert">;

/**
 * Record a fingerprint unless it is already the latest. Returns the new version
 * number, or null when nothing was written. Safe across replicas: losing the
 * insert race means re-reading the latest row and deciding again.
 */
export async function recordFingerprint(
  scope: string,
  slug: string,
  fp: SkillFingerprint,
  origin: SkillVersions.SkillVersionOrigin,
  now: number,
  repo: Repo = SkillVersions,
): Promise<number | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await repo.latest(scope, slug);
    if (current?.contentHash === fp.hash) return null;
    const version = (current?.version ?? 0) + 1;
    const inserted = await repo.insert({
      scope,
      slug,
      version,
      contentHash: fp.hash,
      skillMd: fp.skillMd,
      skillMdTruncated: fp.truncated,
      fileCount: fp.fileCount,
      totalBytes: fp.totalBytes,
      capturedAt: now,
      origin,
    });
    if (inserted) return version;
  }
  throw Object.assign(new Error("lost the version race repeatedly"), { code: "ECONTENDED" });
}

async function capture(scope: string, slug: string, dir: string, src: ProvenanceSources, now: number): Promise<number | null> {
  const fp = await fingerprintSkill(dir);
  const origin = skillProvenance({ slug, authoredBy: parseSkillText(fp.skillMd).authoredBy }, src);
  return recordFingerprint(scope, slug, fp, origin, now);
}

/** An error's code or class name: nothing from a message, which may quote a path or a row. */
function errorLabel(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code) return code;
  return e instanceof Error ? e.name : "error";
}

/** Log one failure per skill and error until that skill captures cleanly again. */
const reported = new Set<string>();
function reportFailure(scope: string, slug: string, e: unknown): void {
  const label = errorLabel(e);
  // Moved or removed while being read (a retire, a restore): the next pass sees it where it is now.
  if (label === "ENOENT") return;
  const key = `${scope}/${slug}/${label}`;
  if (reported.has(key)) return;
  reported.add(key);
  console.error(`[skills] could not capture a version of ${scope}/${slug}: ${label}`);
}
function clearFailures(scope: string, slug: string): void {
  for (const key of reported) if (key.startsWith(`${scope}/${slug}/`)) reported.delete(key);
}

export interface ReconcileResult {
  scanned: number;
  recorded: number;
  failed: number;
}

interface SkillRoot {
  scope: string;
  root: string;
}

/** The shared base and every persona overlay on disk. */
function skillRoots(): SkillRoot[] {
  const roots: SkillRoot[] = [{ scope: GLOBAL_SCOPE, root: globalSkillsRoot() }];
  if (existsSync(paths.personas)) {
    for (const name of readdirSync(paths.personas)) {
      if (name.startsWith(".") || name === "default") continue;
      const root = personaSkillsRoot(name);
      if (existsSync(root)) roots.push({ scope: versionScope(name), root });
    }
  }
  return roots;
}

/** Slugs under a root that are real directories holding a SKILL.md entry of any kind. */
function skillDirs(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    if (entry.startsWith(".")) continue; // `.retired/` among them
    const dir = join(root, entry);
    // A symlinked skill directory is not walked (as the bundled seed refuses one).
    if (!lstatSync(dir).isDirectory()) continue;
    try {
      lstatSync(join(dir, "SKILL.md"));
    } catch {
      continue;
    }
    out.push(entry);
  }
  return out;
}

/**
 * Walk every skill root and record what changed. Each skill stands alone: one
 * that cannot be read is skipped for this pass and the rest continue. Never
 * throws.
 */
export async function reconcileSkillVersions(now: number = Date.now()): Promise<ReconcileResult> {
  const result: ReconcileResult = { scanned: 0, recorded: 0, failed: 0 };
  let src: ProvenanceSources;
  let roots: SkillRoot[];
  try {
    src = provenanceSources();
    roots = skillRoots();
  } catch (e) {
    console.error(`[skills] version reconcile could not list the skill roots: ${errorLabel(e)}`);
    result.failed++;
    return result;
  }
  for (const { scope, root } of roots) {
    let slugs: string[];
    try {
      slugs = skillDirs(root);
    } catch (e) {
      reportFailure(scope, "(root)", e);
      result.failed++;
      continue;
    }
    for (const slug of slugs) {
      result.scanned++;
      try {
        if ((await capture(scope, slug, join(root, slug), src, now)) !== null) result.recorded++;
        clearFailures(scope, slug);
      } catch (e) {
        result.failed++;
        reportFailure(scope, slug, e);
      }
    }
  }
  return result;
}

// Captures and sweeps run one at a time, each reading the disk when its turn
// comes, so two quick writes cannot land in the wrong order.
let queue: Promise<void> = Promise.resolve();
function enqueue(job: () => Promise<unknown>): Promise<void> {
  queue = queue.then(job).then(
    () => {},
    (e) => console.error(`[skills] version capture failed: ${errorLabel(e)}`),
  );
  return queue;
}

/** Resolves when every capture queued so far has finished. */
export const flushSkillVersionCaptures = (): Promise<void> => queue;

/**
 * Record a skill right after a write, retire or restore. `dir` is where the
 * content is now (a retired copy's directory for a retire), so the last edit
 * before a retirement still reaches the log. Fire and forget: never throws and
 * never delays the caller. No-op in a process without a database.
 */
export function noteSkillChanged(personaName: string | undefined, slug: string, dir: string): void {
  if (env.role() === "node") return;
  const scope = versionScope(personaName);
  void enqueue(async () => {
    try {
      await capture(scope, slug, dir, provenanceSources(), Date.now());
      clearFailures(scope, slug);
    } catch (e) {
      reportFailure(scope, slug, e);
    }
  });
}

let sweepQueued = false;

function queueSweep(): void {
  if (sweepQueued) return;
  sweepQueued = true;
  void enqueue(async () => {
    try {
      const r = await reconcileSkillVersions();
      if (r.recorded > 0) console.log(`[skills] recorded ${r.recorded} new skill version(s) across ${r.scanned} skill(s)`);
    } finally {
      sweepQueued = false;
    }
  });
}

/** Reconcile now and then every SLAUDE_SKILL_VERSION_RECONCILE_MINUTES (default 5). Gateway and mono only. */
export function startSkillVersionReconciler(): () => void {
  if (env.role() === "node") return () => {};
  queueSweep();
  const timer = setInterval(queueSweep, env.skillVersionReconcileMinutes() * 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
