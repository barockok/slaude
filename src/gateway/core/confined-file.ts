import { closeSync, constants, createReadStream, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import { basename, isAbsolute, sep } from "node:path";
import type { ReadStream } from "node:fs";

/** A path an agent named is not a regular file inside the session's folder. The
 *  message is for the agent: it names the file's base name only, never the path. */
export class UploadRefusal extends Error {
  constructor(path: string) {
    super(`upload refused: ${basename(path) || "file"} is not a regular file under this session's working directory`);
    this.name = "UploadRefusal";
  }
}

export interface ConfinedFile {
  /** Reads the descriptor that was checked, not the path. Closes it at the end. */
  stream: ReadStream;
  /** Base name of the resolved file (what a symlink points at), for a default title. */
  name: string;
}

const inside = (root: string, file: string): boolean => file.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Open `path` for reading only when its realpath is a regular file inside the
 * realpath of `workingDir`. The descriptor is opened once and checked with
 * fstat, and the caller streams from that descriptor, so a later swap of the
 * path cannot change what is read. Any failure (no working dir, a missing
 * file, a symlink or `..` leading out, a directory, FIFO, device or socket)
 * throws UploadRefusal. A FIFO is opened non-blocking so the check never hangs.
 */
export function openConfined(path: string, workingDir: string | undefined): ConfinedFile {
  if (!workingDir || !isAbsolute(path)) throw new UploadRefusal(path);
  let fd = -1;
  try {
    const root = realpathSync(workingDir);
    const real = realpathSync(path);
    if (!inside(root, real)) throw new UploadRefusal(path);
    fd = openSync(real, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile()) throw new UploadRefusal(path);
    // Re-resolve after the open: the descriptor must still be the file at a path inside the folder.
    const again = realpathSync(path);
    const now = lstatSync(again);
    if (!inside(root, again) || now.ino !== st.ino || now.dev !== st.dev) throw new UploadRefusal(path);
    const stream = createReadStream("", { fd, autoClose: true });
    return { stream, name: basename(real) };
  } catch (e) {
    if (fd >= 0) { try { closeSync(fd); } catch { /* already closed */ } }
    throw e instanceof UploadRefusal ? e : new UploadRefusal(path);
  }
}
