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
 * The directory is removed when the session is no longer warm on the node, and
 * the whole root when the worker stops. This is a guard against mistakes, not a
 * boundary: an agent with a shell on the same node can read other sessions'
 * directories if it knows the path (same user).
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
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

  /** The session's directory, created (0700) if it does not exist. */
  ensure(sessionId: string): string {
    const dir = join(this.#rootDir(), segment(sessionId));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700); // the umask may have narrowed the mode, never widened it
    return dir;
  }

  /** The session's directory when it exists, else undefined. */
  pathFor(sessionId: string): string | undefined {
    if (!this.#root) return undefined;
    const dir = join(this.#root, segment(sessionId));
    try {
      return statSync(dir).isDirectory() ? dir : undefined;
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

type Overlay = Record<string, string | undefined> | ChildEnvPatch | undefined;

/**
 * Wrap a node's child-env resolver so the agent process gets the session's
 * scratch directory as TMPDIR and SLAUDE_SCRATCH. The directory is created
 * here, at boot, before the agent can ask for it. Nothing else is added.
 */
export function withScratchEnv(
  inner: (sessionId: string) => Promise<Overlay>,
  scratch: ScratchDirs,
): (sessionId: string) => Promise<Overlay> {
  return async (sessionId) => {
    const dir = scratch.ensure(sessionId);
    const add = { TMPDIR: dir, SLAUDE_SCRATCH: dir };
    const overlay = await inner(sessionId);
    if (overlay instanceof ChildEnvPatch) return new ChildEnvPatch({ ...overlay.set, ...add }, overlay.unset);
    return { ...(overlay ?? {}), ...add };
  };
}
