import { RemoteConn, type SocketFactory } from "./conn";
import { shq } from "./shell";
import { cleanupCommand } from "./tools/bash";
import { hostVerifierFor, socketFor, usernameFor, type ConnectInfo } from "./transport";
import { RemoteError } from "./types";

function connFor(info: ConnectInfo, readyTimeoutMs: number, socket?: SocketFactory, record?: (fp: string) => void): RemoteConn {
  return new RemoteConn({
    socket: socket ?? socketFor(info.transport),
    privateKey: info.privateKey,
    username: usernameFor(info.transport),
    hostVerifier: hostVerifierFor(info.transport, record),
    reconnectDelayMs: 0,
    readyTimeoutMs,
  });
}

/** Map a failed `cd && pwd -P` to a user-facing message. Perl is a hard
 *  dependency of the remote tools (process-group wrapper), and without it the
 *  wrapper fails before `cd` ever runs — that must not read as a bad directory. */
export function describePreflightFailure(r: { code: number | null; stdout: string; stderr: string }, dir: string): string {
  if (r.code === 127 || /\bperl\b[^\n]*not found|not found[^\n]*\bperl\b/i.test(`${r.stderr}\n${r.stdout}`)) {
    return "perl is required in the environment for remote tools (it ships with macOS and most Linux)";
  }
  return `directory not found or not accessible: ${dir}`;
}

export type PreflightResult = { ok: true; dir: string; hostKey?: string } | { ok: false; error: string };

/** Connect once and resolve the directory. Nothing is stored unless this succeeds.
 *  An ssh transport with no pinned host key records the presented one and returns
 *  it as `hostKey` (trust on first use); a pinned one must match. */
export async function preflight(i: { info: ConnectInfo; dir: string; socket?: SocketFactory }): Promise<PreflightResult> {
  let conn: RemoteConn;
  let seen: string | undefined;
  const t = i.info.transport;
  const recording = t.kind === "ssh" && !t.hostKey;
  try {
    conn = connFor(i.info, 20_000, i.socket, recording ? (fp) => { seen = fp; } : undefined);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  try {
    const cd = i.dir === "~" ? `cd "$HOME"` : i.dir.startsWith("~/") ? `cd "$HOME"/${shq(i.dir.slice(2))}` : `cd ${shq(i.dir)}`;
    const r = await conn.exec(`${cd} && pwd -P`, { timeoutMs: 20_000 });
    if (r.code !== 0) return { ok: false, error: describePreflightFailure(r, i.dir) };
    return { ok: true, dir: r.stdout.trim(), ...(recording && seen ? { hostKey: seen } : {}) };
  } catch (e) {
    return { ok: false, error: e instanceof RemoteError ? e.message : String((e as Error).message ?? e) };
  } finally {
    conn.close();
  }
}

/** Best-effort: kill a session's background jobs on the remote when remote mode
 *  ends (spec §5.2). Runs from the gateway so it works in split deploys even if
 *  no further turn ever reaches a node. Never throws; never logs the address or key. */
export async function remoteCleanup(i: { info: ConnectInfo; sessionKey: string; socket?: SocketFactory }): Promise<void> {
  let conn: RemoteConn | undefined;
  try {
    conn = connFor(i.info, 15_000, i.socket);
    await conn.exec(cleanupCommand(i.sessionKey), { timeoutMs: 30_000 });
  } catch (e) {
    console.error(`[remote] cleanup skipped: ${e instanceof RemoteError ? e.code : "error"}`);
  } finally {
    conn?.close();
  }
}
