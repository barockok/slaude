export type RemoteErrorCode = "REMOTE_UNREACHABLE" | "REMOTE_AUTH_FAILED" | "REMOTE_HOST_CHANGED" | "REMOTE_PROVISION_FAILED";

/** Transport-level failure. Tool-level failures (non-zero exit, missing file)
 *  are ordinary ExecResults, not RemoteErrors. `started` = the command may
 *  already have run on the remote, so it must not be retried automatically. */
export class RemoteError extends Error {
  constructor(readonly code: RemoteErrorCode, message: string, readonly started = false) {
    super(`${code}: ${message}`);
    this.name = "RemoteError";
  }
}

export interface ExecOpts {
  stdin?: string;
  timeoutMs: number;
  /** Run under `bash -lc` (user's PATH/profile). Only the bash tool sets this. */
  login?: boolean;
  /** Head size kept before truncating stdout (default 30_000 chars). */
  maxOutput?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  truncated: boolean;
  timedOut: boolean;
}

export type Exec = (cmd: string, opts: ExecOpts) => Promise<ExecResult>;

export type EnvTrust = "user-machine" | "provisioned";

/** Which saved environment a remote thread runs in. Not sensitive: no address. */
export interface EnvRef {
  id: string;
  kind: string;
  trust: EnvTrust;
  /** Environment name, shown to the model and in status lines. */
  name: string;
  /** Changes when the environment's config (or a sandbox's generation) changes. */
  hash: string;
}

export interface RemoteTarget {
  teamId: string;
  /** The environment's owner. */
  userId: string;
  /** tailcat address for tailcat environments (older nodes read it); "" otherwise. */
  addr: string;
  dir: string;
  /** Absent only in tokens from a gateway that predates environments (tailcat). */
  env?: EnvRef;
}

export interface RemoteHandle {
  exec: Exec;
  /** Release the connection only (session reboot / idle). Background jobs keep
   *  running; a later exec reconnects lazily. */
  release(): Promise<void>;
  /** Remote mode ended for this session: kill its background jobs, then release. */
  dispose(): Promise<void>;
}
