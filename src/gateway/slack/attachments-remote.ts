import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { env } from "../../config/env";
import { objectStore, putInbox, storageMode, type ObjectStore } from "../../storage";
import { downloadAttachments, type DownloadedFile, type SlackFile } from "./attachments";

/**
 * Save the files a message carries for the agent to read. Where the gateway owns the working directory (a
 * single process, or no remote storage) that is the download itself. On a gateway with remote storage the node owns
 * it, so the files go through the bucket's inbox (see stageForNodes) and the result names the paths the node will
 * place them at.
 */
export async function downloadInboundFiles(args: {
  files: SlackFile[];
  botToken: string;
  workingDir: string;
  inboundTs: string;
}): Promise<DownloadedFile[]> {
  if (!(storageMode() === "s3" && env.role() === "gateway")) return downloadAttachments(args);
  const stageDir = mkdtempSync(join(tmpdir(), "slaude-att-"));
  try {
    const got = await downloadAttachments({ ...args, workingDir: stageDir });
    return await stageForNodes({ store: objectStore()!, files: got, stageDir, workingDir: args.workingDir });
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

/**
 * With remote storage the gateway does not write into a session's working directory: the node that runs the turn
 * owns it, and on a volume both share a directory the gateway made would be unwritable for a non-root node. So the
 * gateway downloads an attachment into a private staging directory instead, puts it in the bucket's inbox under
 * the path it should have in the working directory, and the node places it there before the turn.
 *
 * Returns the files as the agent should see them: at their path inside the real working directory. A file that
 * could not be staged is left out (and logged), so the agent is never pointed at a path that will not exist.
 */
export async function stageForNodes(args: {
  store: ObjectStore;
  files: DownloadedFile[];
  /** Where `files` were downloaded to (the directory standing in for the working directory). */
  stageDir: string;
  workingDir: string;
}): Promise<DownloadedFile[]> {
  const out: DownloadedFile[] = [];
  for (const f of args.files) {
    const rel = relative(args.stageDir, f.path).split(sep).join("/");
    try {
      await putInbox(args.store, args.workingDir, f.path, rel);
      out.push({ ...f, path: join(args.workingDir, rel) });
    } catch (e) {
      console.error(`[attachments] could not stage ${f.name} for the node: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}
