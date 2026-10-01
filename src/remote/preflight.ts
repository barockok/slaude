import { RemoteConn, type SocketFactory } from "./conn";
import { shq } from "./shell";
import { tailcatSocket } from "./tailcat";
import { cleanupCommand } from "./tools/bash";
import { RemoteError } from "./types";

/** Map a failed `cd && pwd -P` to a user-facing message. Perl is a hard
 *  dependency of the remote tools (process-group wrapper), and without it the
 *  wrapper fails before `cd` ever runs — that must not read as a bad directory. */
export function describePreflightFailure(r: { code: number | null; stdout: string; stderr: string }, dir: string): string {
  if (r.code === 127 || /\bperl\b[^\n]*not found|not found[^\n]*\bperl\b/i.test(`${r.stderr}\n${r.stdout}`)) {
    return "perl is required on your machine for /remote (it ships with macOS and most Linux)";
  }
  return `directory not found or not accessible: ${dir}`;
}

/** Connect once and resolve the directory. Nothing is stored unless this succeeds. */
export async function preflight(i: { addr: string; dir: string; privateKey: string; socket?: SocketFactory }): Promise<{ ok: true; dir: string } | { ok: false; error: string }> {
  let conn: RemoteConn;
  try {
    conn = new RemoteConn({ socket: i.socket ?? tailcatSocket(i.addr), privateKey: i.privateKey, reconnectDelayMs: 0, readyTimeoutMs: 20_000 });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  try {
    const cd = i.dir === "~" ? `cd "$HOME"` : i.dir.startsWith("~/") ? `cd "$HOME"/${shq(i.dir.slice(2))}` : `cd ${shq(i.dir)}`;
    const r = await conn.exec(`${cd} && pwd -P`, { timeoutMs: 20_000 });
    if (r.code !== 0) return { ok: false, error: describePreflightFailure(r, i.dir) };
    return { ok: true, dir: r.stdout.trim() };
  } catch (e) {
    return { ok: false, error: e instanceof RemoteError ? e.message : String((e as Error).message ?? e) };
  } finally {
    conn.close();
  }
}

/** Best-effort: kill a session's background jobs on the remote when remote mode
 *  ends (spec §5.2). Runs from the gateway so it works in split deploys even if
 *  no further turn ever reaches a node. Never throws; never logs the address or key. */
export async function remoteCleanup(i: { addr: string; privateKey: string; sessionKey: string; socket?: SocketFactory }): Promise<void> {
  let conn: RemoteConn | undefined;
  try {
    conn = new RemoteConn({ socket: i.socket ?? tailcatSocket(i.addr), privateKey: i.privateKey, reconnectDelayMs: 0, readyTimeoutMs: 15_000 });
    await conn.exec(cleanupCommand(i.sessionKey), { timeoutMs: 30_000 });
  } catch (e) {
    console.error(`[remote] cleanup skipped: ${e instanceof RemoteError ? e.code : "error"}`);
  } finally {
    conn?.close();
  }
}
