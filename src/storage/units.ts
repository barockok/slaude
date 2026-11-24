import { createHash } from "node:crypto";
import { resolve } from "node:path";

/** The SDK names a project directory after its cwd with every non-alphanumeric character replaced by `-`. */
export const encodeProjectDir = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, "-");

const dirHash = (p: string): string => createHash("sha256").update(resolve(p)).digest("hex").slice(0, 32);

/**
 * Sync units are directories, not sessions: a proactive or channel folder is shared by several
 * sessions, and keying by session would make them overwrite each other's copy.
 */
export const wsUnitId = (workingDir: string): string => `ws-${dirHash(workingDir)}`;
export const txUnitId = (transcriptDir: string): string => `tx-${dirHash(transcriptDir)}`;

/**
 * A boxed session's home. Keyed by session, unlike the others: a home belongs to one
 * sandbox, so two sessions never share one and closing the session decides its fate.
 * An id that is not safe as a key segment is hashed.
 */
export const hmUnitId = (sessionId: string): string =>
  /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(sessionId) && !sessionId.includes("..")
    ? `hm-${sessionId}`
    : `hm-${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`;

/**
 * The workspace trees the ignore list skips (installs, caches), keyed by directory and by box image:
 * native modules are built against the image's libraries, so each image gets its own.
 */
export function wxUnitId(workingDir: string, digest: string): string {
  const hex = digest.replace(/^[a-z0-9]+:/, "");
  if (!/^[0-9a-f]{12,}$/.test(hex)) throw new Error("wxUnitId: the box digest is not a hex digest");
  return `wx-${dirHash(workingDir)}-${hex.slice(0, 12)}`;
}
