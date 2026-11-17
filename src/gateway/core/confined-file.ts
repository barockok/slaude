import { closeSync, constants, createReadStream, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import { basename, isAbsolute, sep } from "node:path";
import type { ReadStream } from "node:fs";

/** A path an agent named is not a regular file inside the session's folder. The
 *  message is for the agent: it names the file's base name only, never the path. */
export class UploadRefusal extends Error {
  constructor(path: string) {
    super(`upload refused: ${basename(path) || "file"} is not a regular file under this session's working directory. Copy the file into your working directory and upload it from there.`);
    this.name = "UploadRefusal";
  }
}

/** The file is larger than the co-located path may send. For the agent: names the base name and sizes, never the path. */
export class UploadTooLarge extends Error {
  constructor(path: string, size: number, max: number) {
    super(`upload refused: ${basename(path) || "file"} is ${size} bytes, over the limit of ${max} bytes for this upload path`);
    this.name = "UploadTooLarge";
  }
}

export interface ConfinedFile {
  /** Size of the checked descriptor in bytes. */
  size: number;
  /** Reads the descriptor that was checked, not the path. Closes it at the end. */
  stream: ReadStream;
  /** Base name of the resolved file (what a symlink points at), for a default title. */
  name: string;
}

const inside = (root: string, file: string): boolean => file.startsWith(root.endsWith(sep) ? root : root + sep);

/** A descriptor that passed the checks of openConfinedFd. The caller owns it. */
export interface ConfinedFd {
  fd: number;
  size: number;
  /** Base name of the resolved file (what a symlink points at). */
  name: string;
}

/**
 * Open `path` for reading only when its realpath is a regular file inside the
 * realpath of one of `roots`. The descriptor is opened once and checked with
 * fstat, so a later swap of the path cannot change what is read through it.
 * Any failure (no root, a missing file, a symlink or `..` leading out, a
 * directory, FIFO, device or socket) throws UploadRefusal and closes the
 * descriptor. A FIFO is opened non-blocking so the check never hangs.
 */
export function openConfinedFd(path: string, roots: readonly string[]): ConfinedFd {
  if (!isAbsolute(path)) throw new UploadRefusal(path);
  let fd = -1;
  try {
    const real = realpathSync(path);
    const inRoots = (file: string): string | undefined =>
      roots.map((r) => { try { return realpathSync(r); } catch { return undefined; } }).find((r): r is string => !!r && inside(r, file));
    const root = inRoots(real);
    if (!root) throw new UploadRefusal(path);
    fd = openSync(real, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile()) throw new UploadRefusal(path);
    // Re-resolve after the open: the descriptor must still be the file at a path inside the folder.
    const again = realpathSync(path);
    const now = lstatSync(again);
    if (!inside(root, again) || now.ino !== st.ino || now.dev !== st.dev) throw new UploadRefusal(path);
    return { fd, size: st.size, name: basename(real) };
  } catch (e) {
    if (fd >= 0) { try { closeSync(fd); } catch { /* already closed */ } }
    throw e instanceof UploadRefusal ? e : new UploadRefusal(path);
  }
}

/** The co-located path: one root (the session working directory), streamed from the checked descriptor. */
export function openConfined(path: string, workingDir: string | undefined): ConfinedFile {
  if (!workingDir) throw new UploadRefusal(path);
  const f = openConfinedFd(path, [workingDir]);
  return { stream: createReadStream("", { fd: f.fd, autoClose: true }), name: f.name, size: f.size };
}
