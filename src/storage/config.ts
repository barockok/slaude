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

const bool = (name: string, raw: string | undefined, dflt: boolean): boolean => {
  if (raw === undefined || raw.trim() === "") return dflt;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes"].includes(v)) return true;
  if (["0", "false", "no"].includes(v)) return false;
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
  };
}
