import { mkdirSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";

export type SlackFile = {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
};

export type DownloadedFile = {
  id: string;
  name: string;
  path: string;
  mimetype: string;
  size: number;
};

/** Sanitize a filename — keep alnum/dot/dash/underscore. */
function safeName(name: string, fallback: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/_+/g, "_");
  return cleaned || fallback;
}

/**
 * Download Slack file attachments into the session's working dir.
 *
 *   <working_dir>/attachments/<inbound_ts>/<filename>
 *
 * Slack private file URLs require `Authorization: Bearer <bot_token>`.
 * Returns paths so the adapter can surface them to the agent.
 */
export async function downloadAttachments(args: {
  files: SlackFile[];
  botToken: string;
  workingDir: string;
  inboundTs: string;
}): Promise<DownloadedFile[]> {
  const { files, botToken, workingDir, inboundTs } = args;
  if (!files.length) return [];

  const dir = join(workingDir, "attachments", inboundTs);
  mkdirSync(dir, { recursive: true });

  const out: DownloadedFile[] = [];
  for (const f of files) {
    const url = f.url_private_download || f.url_private;
    if (!url) continue;
    const filename = safeName(f.name || f.title || `${f.id}.${f.filetype ?? "bin"}`, f.id);
    const dest = join(dir, filename);
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${botToken}` },
      });
      if (!res.ok || !res.body) {
        console.error(`[slack-attach] ${filename}: HTTP ${res.status}`);
        continue;
      }
      // Stream body → file. Node stream interop with web ReadableStream.
      await new Promise<void>((resolve, reject) => {
        const sink = createWriteStream(dest);
        const src = Readable.fromWeb(res.body as any);
        src.pipe(sink);
        sink.on("finish", () => resolve());
        sink.on("error", reject);
        src.on("error", reject);
      });
      out.push({
        id: f.id,
        name: filename,
        path: dest,
        mimetype: f.mimetype || "application/octet-stream",
        size: f.size ?? 0,
      });
    } catch (e: any) {
      console.error(`[slack-attach] ${filename}: ${e?.message ?? String(e)}`);
    }
  }
  return out;
}
