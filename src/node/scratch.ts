/**
 * Per-session scratch directories on a node.
 *
 * The gateway creates a session's working directory (root-owned on the live
 * topology) and the worker may run as another user, so an agent can have no
 * directory it can both write and upload from. This gives each session one
 * private place that is always writable: `<root>/<session>`, mode 0700, where
 * `<root>` is a fresh 0700 directory under the node's temp area. The agent
 * learns it as TMPDIR (so ordinary tools write there) and SLAUDE_SCRATCH. The
 * upload tool accepts the working directory and this directory, and nothing
 * else under the temp area: /tmp is shared by every session on the worker.
 *
 * The directory is removed when the session is no longer warm on the node (a
 * cold resume, or a session that moves to another node, starts with an empty
 * one), and the whole root when the worker stops. A crashed worker leaves its
 * root behind; sweepStaleScratchRoots clears old ones at the next start. This is a guard against mistakes, not a
 * boundary: an agent with a shell on the same node can read other sessions'
 * directories if it knows the path (same user).
 */
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChildEnvPatch } from "../agent/child-env";

/** A session id as a single safe path segment: ids are uuids, but never trust that. */
function segment(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  if (safe === "" || safe === "." || safe === "..") return `s_${Buffer.from(sessionId).toString("hex") || "empty"}`;
  // Distinct ids that reduce to the same text must not share a directory.
  return safe === sessionId ? safe : `${safe}-${Buffer.from(sessionId).toString("hex").slice(0, 16)}`;
}

export class ScratchDirs {
  #root: string | undefined;
  #parent: string | undefined;

  constructor(opts: { parent?: string } = {}) {
    this.#parent = opts.parent;
  }

  /** The root, created on first use (mkdtemp makes it 0700). */
  #rootDir(): string {
    return (this.#root ??= mkdtempSync(join(this.#parent ?? tmpdir(), "slaude-scratch-")));
  }

  /** The session's directory, created (0700) if it does not exist. A symlink or a
   *  file already at that path is refused, and nothing is chmod'ed through a link. */
  ensure(sessionId: string): string {
    const dir = join(this.#rootDir(), segment(sessionId));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory() || (process.getuid && st.uid !== process.getuid())) {
      throw new Error("scratch path is not a directory this worker owns");
    }
    chmodSync(dir, 0o700); // the umask may have narrowed the mode, never widened it
    return dir;
  }

  /** The session's directory when it exists (a real directory, not a link), else undefined. */
  pathFor(sessionId: string): string | undefined {
    if (!this.#root) return undefined;
    const dir = join(this.#root, segment(sessionId));
    try {
      const st = lstatSync(dir);
      return st.isDirectory() && !st.isSymbolicLink() ? dir : undefined;
    } catch {
      return undefined;
    }
  }

  /** Remove one session's directory and everything in it. */
  remove(sessionId: string): void {
    if (!this.#root) return;
    rmSync(join(this.#root, segment(sessionId)), { recursive: true, force: true });
  }

  /** Remove the root (the worker is stopping). */
  removeAll(): void {
    if (!this.#root) return;
    rmSync(this.#root, { recursive: true, force: true });
    this.#root = undefined;
  }
}

/**
 * Remove scratch roots a crashed worker left behind: `slaude-scratch-*` directly
 * under `parent`, owned by this worker's uid and not touched for `maxAgeMs`
 * (default a day). Returns how many were removed. Never follows a link.
 */
export function sweepStaleScratchRoots(
  parent: string = tmpdir(),
  o: { maxAgeMs?: number; uid?: number; now?: number } = {},
): number {
  const maxAge = o.maxAgeMs ?? 86_400_000;
  const uid = o.uid ?? process.getuid?.();
  let n = 0;
  let names: string[] = [];
  try { names = readdirSync(parent); } catch { return 0; }
  for (const name of names) {
    if (!name.startsWith("slaude-scratch-")) continue;
    try {
      const p = join(parent, name);
      const st = lstatSync(p);
      if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid) continue;
      if ((o.now ?? Date.now()) - st.mtimeMs < maxAge) continue;
      rmSync(p, { recursive: true, force: true });
      n++;
    } catch { /* best effort */ }
  }
  return n;
}

type Overlay = Record<string, string | undefined> | ChildEnvPatch | undefined;

let warnedScratch = false;

/**
 * Wrap a node's child-env resolver so the agent process gets the session's
 * scratch directory as TMPDIR and SLAUDE_SCRATCH. The directory is created
 * here, at boot, before the agent can ask for it. Nothing else is added.
 *
 * When the directory cannot be made (a read-only or full temp area, a planted
 * link) the session still boots without those two variables, so one bad temp
 * area does not stop every session on the node; uploads then accept the
 * working directory only. Logged once per worker.
 */
export function withScratchEnv(
  inner: (sessionId: string) => Promise<Overlay>,
  scratch: ScratchDirs,
): (sessionId: string) => Promise<Overlay> {
  return async (sessionId) => {
    let add: Record<string, string> | undefined;
    try {
      const dir = scratch.ensure(sessionId);
      add = { TMPDIR: dir, SLAUDE_SCRATCH: dir };
    } catch (e) {
      if (!warnedScratch) {
        warnedScratch = true;
        const code = typeof (e as { code?: unknown })?.code === "string" ? ` (${(e as { code: string }).code})` : "";
        console.warn(`[node] scratch directory unavailable${code}: sessions start without TMPDIR and SLAUDE_SCRATCH, and uploads can only read from the working directory`);
      }
    }
    const overlay = await inner(sessionId);
    if (!add) return overlay;
    if (overlay instanceof ChildEnvPatch) return new ChildEnvPatch({ ...overlay.set, ...add }, overlay.unset);
    return { ...(overlay ?? {}), ...add };
  };
}
