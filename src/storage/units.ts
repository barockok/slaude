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
