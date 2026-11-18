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

/** Stage one file that belongs at `<workingDir>/<rel>`. */
export async function putInbox(store: ObjectStore, workingDir: string, absFile: string): Promise<void> {
  const root = resolve(workingDir);
  const abs = resolve(absFile);
  if (!abs.startsWith(root + sep)) throw new StorageError("put", `inbox file '${absFile}' is outside its working directory`);
  const rel = relative(root, abs).split(sep).join("/");
  if (!validRel(rel)) throw new StorageError("put", `inbox path '${rel}' is not a safe relative path`);
  await store.put(`${inboxPrefix(wsUnitId(workingDir))}${rel}`, Bun.file(abs));
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
    const body = await store.get(key);
    if (!body) continue;
    const dest = ensureParents(rootDir, rel);
    const tmp = `${dest}.slaude-sync.${randomBytes(4).toString("hex")}`;
    try {
      await pipeline(Readable.fromWeb(body as never), createWriteStream(tmp));
      chmodSync(tmp, 0o644);
      renameSync(tmp, dest);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    await store.delete([key]);
    n++;
  }
  return n;
}
