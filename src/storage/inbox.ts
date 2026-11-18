import { chmodSync, createWriteStream, renameSync, rmSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StorageError, type ObjectStore } from "./object-store";
import { ensureParents, validRel } from "./tree-sync";
import { wsUnitId } from "./units";

/**
 * A drop box for files that arrive at a session from a process that does not run it, such as the
 * gateway saving a Slack attachment. The gateway cannot write into a node's working directory and
 * must not commit a manifest (it holds no epoch), so it puts the file here, keyed by the
 * directory's sync unit and the path the file should have. The node that takes the session writes
 * the files into the directory after it hydrates and removes them from the box; the next flush
 * carries them into the stored tree.
 */
const inboxPrefix = (unitId: string): string => `inbox/${unitId}/`;

/**
 * Stage one file that belongs at `<workingDir>/<rel>`. `rel` is derived from where the file is, which must then be
 * inside `workingDir`; or the caller names it, for a file saved elsewhere (a private temp directory) on its way to a
 * working directory it must not write into.
 */
export async function putInbox(store: ObjectStore, workingDir: string, absFile: string, rel?: string): Promise<void> {
  const abs = resolve(absFile);
  let path = rel;
  if (path === undefined) {
    const root = resolve(workingDir);
    if (!abs.startsWith(root + sep)) throw new StorageError("put", `inbox file '${absFile}' is outside its working directory`);
    path = relative(root, abs).split(sep).join("/");
  }
  if (!validRel(path)) throw new StorageError("put", `inbox path '${path}' is not a safe relative path`);
  await store.put(`${inboxPrefix(wsUnitId(workingDir))}${path}`, Bun.file(abs));
}

/** Write every staged file into `rootDir` and remove it from the box. Returns how many arrived. */
export async function drainInbox(store: ObjectStore, unitId: string, rootDir: string): Promise<number> {
  const prefix = inboxPrefix(unitId);
  const keys: string[] = [];
  for await (const o of store.list(prefix)) keys.push(o.key);
  let n = 0;
  for (const key of keys) {
    const rel = key.slice(prefix.length);
    if (!validRel(rel)) {
      await store.delete([key]);
      continue;
    }
    // One file the node cannot place (a directory an earlier root process left, say) must not hold up the others,
    // so each is its own attempt. A file that fails stays in the box and is tried again at the next turn.
    let tmp: string | undefined;
    try {
      const body = await store.get(key);
      if (!body) continue;
      const dest = ensureParents(rootDir, rel);
      tmp = `${dest}.slaude-sync.${randomBytes(4).toString("hex")}`;
      await pipeline(Readable.fromWeb(body as never), createWriteStream(tmp));
      chmodSync(tmp, 0o644);
      renameSync(tmp, dest);
      await store.delete([key]);
      n++;
    } catch (e) {
      if (tmp) rmSync(tmp, { force: true });
      console.error(`[inbox] could not place ${rel} for unit=${unitId}: ${e instanceof Error ? e.message : String(e)} (kept for the next turn)`);
    }
  }
  return n;
}
