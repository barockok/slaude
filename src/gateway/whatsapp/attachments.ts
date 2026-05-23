import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WAMessage } from "@whiskeysockets/baileys";
import { downloadMediaMessage } from "@whiskeysockets/baileys";

export type DownloadedFile = {
  name: string;
  path: string;
  mimetype: string;
  size: number;
};

/** Sanitize a filename. */
function safeName(name: string, fallback: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/_+/g, "_");
  return cleaned || fallback;
}

/**
 * Download WhatsApp media attachments into the session's working dir.
 *
 *   <working_dir>/attachments/<msg_id>/<filename>
 */
export async function downloadAttachments(args: {
  message: WAMessage;
  workingDir: string;
  msgId: string;
}): Promise<DownloadedFile[]> {
  const { message, workingDir, msgId } = args;
  const mediaTypes = ["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage"];
  const msg = message.message;
  if (!msg) return [];

  const mediaType = mediaTypes.find((t) => t in msg);
  if (!mediaType) return [];

  const dir = join(workingDir, "attachments", msgId);
  mkdirSync(dir, { recursive: true });

  try {
    const buffer = await downloadMediaMessage(
      message,
      "buffer",
      {},
      { logger: undefined as any, reuploadRequest: undefined as any },
    );
    if (!Buffer.isBuffer(buffer)) return [];

    const media = (msg as any)[mediaType];
    const ext = {
      imageMessage: ".jpg",
      videoMessage: ".mp4",
      audioMessage: ".ogg",
      documentMessage: ".bin",
      stickerMessage: ".webp",
    }[mediaType] ?? ".bin";

    const filename = safeName(media?.fileName || `media${ext}`, `media${ext}`);
    const dest = join(dir, filename);
    writeFileSync(dest, buffer);

    return [{
      name: filename,
      path: dest,
      mimetype: media?.mimetype || "application/octet-stream",
      size: buffer.length,
    }];
  } catch (e: any) {
    console.error(`[whatsapp-attach] download failed: ${e?.message ?? String(e)}`);
    return [];
  }
}
