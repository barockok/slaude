import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StorageError } from "./object-store";

/** `fs` keeps today's behavior (a local or shared filesystem); `s3` syncs session state to an S3-compatible store. */
export type StorageMode = "fs" | "s3";
export type SyncFlush = "turn" | "idle";

export interface S3Config {
  /** Empty means the AWS default endpoint for the region. */
  endpoint: string;
  region: string;
  bucket: string;
  /** Key prefix, no leading or trailing slash. */
  prefix: string;
  /** Path-style addressing. Defaults on when a custom endpoint is set. */
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  /** Deadline for one metadata request (head, list, delete, the existence check of a get). A put gets ten times it. */
  timeoutMs?: number;
}

type Env = Record<string, string | undefined>;

export function storageMode(env: Env = process.env): StorageMode {
  const raw = (env.SLAUDE_STORAGE ?? "fs").trim().toLowerCase();
  if (raw === "" || raw === "fs") return "fs";
  if (raw === "s3") return "s3";
  throw new StorageError("config", `SLAUDE_STORAGE must be 'fs' or 's3' (got '${raw}')`);
}

export function syncFlush(env: Env = process.env): SyncFlush {
  const raw = (env.SLAUDE_SYNC_FLUSH ?? "turn").trim().toLowerCase();
  if (raw === "" || raw === "turn") return "turn";
  if (raw === "idle") return "idle";
  throw new StorageError("config", `SLAUDE_SYNC_FLUSH must be 'turn' or 'idle' (got '${raw}')`);
}

/**
 * Where a node keeps its sync markers (and the skills sync state), or null for the default under `$SLAUDE_HOME`.
 * A deployment whose worker cannot write `$SLAUDE_HOME` (a non-root worker beside a root-owned shared data
 * directory) points this at a directory the worker owns. It must survive a worker restart: the markers say
 * which stored state each local directory matches, and without them the next hydrate is a full pass.
 */
export function syncStateDir(env: Env = process.env): string | null {
  const raw = (env.SLAUDE_SYNC_STATE_DIR ?? "").trim();
  if (raw === "") return null;
  if (!raw.startsWith("/")) throw new StorageError("config", `SLAUDE_SYNC_STATE_DIR must be an absolute path (got '${raw}')`);
  return raw.replace(/\/+$/, "") || "/";
}

/**
 * Make the sync state directory and prove this process can write it, at boot. Otherwise a directory the worker may
 * not write shows up as a failed hydrate on every turn, after the whole session was downloaded.
 */
export function checkSyncStateDir(dir: string): void {
  const probe = join(dir, `.probe-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
  } catch (e) {
    throw new StorageError("config", `SLAUDE_SYNC_STATE_DIR ${dir} is not writable: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const bool = (name: string, raw: string | undefined, dflt: boolean): boolean => {
  if (raw === undefined || raw.trim() === "") return dflt;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new StorageError("config", `${name} must be 1 or 0 (got '${raw}')`);
};

/** The S3 settings, every missing required one listed at once. */
export function s3Config(env: Env = process.env): S3Config {
  const missing: string[] = [];
  const need = (name: string): string => {
    const v = (env[name] ?? "").trim();
    if (!v) missing.push(name);
    return v;
  };
  const endpoint = (env.SLAUDE_S3_ENDPOINT ?? "").trim().replace(/\/+$/, "");
  const bucket = need("SLAUDE_S3_BUCKET");
  const accessKeyId = need("SLAUDE_S3_ACCESS_KEY_ID");
  const secretAccessKey = need("SLAUDE_S3_SECRET_ACCESS_KEY");
  if (missing.length > 0) throw new StorageError("config", `SLAUDE_STORAGE=s3 needs ${missing.join(", ")}`);
  return {
    endpoint,
    region: (env.SLAUDE_S3_REGION ?? "").trim() || "us-east-1",
    bucket,
    prefix: (env.SLAUDE_S3_PREFIX ?? "").trim().replace(/^\/+|\/+$/g, ""),
    pathStyle: bool("SLAUDE_S3_PATH_STYLE", env.SLAUDE_S3_PATH_STYLE, endpoint !== ""),
    accessKeyId,
    secretAccessKey,
    timeoutMs: timeoutMs(env.SLAUDE_S3_TIMEOUT_MS),
  };
}

function timeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 60_000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1000) throw new StorageError("config", `SLAUDE_S3_TIMEOUT_MS must be a whole number of milliseconds, 1000 or more (got '${raw}')`);
  return n;
}
