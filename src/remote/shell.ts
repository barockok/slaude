/** POSIX single-quote a string so the remote shell passes it through literally. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export const PGRP_MARKER = "__SLAUDE_PGID__";

/** perl is present on stock macOS and Debian/Ubuntu; macOS has no `setsid`.
 *  setpgrp gives the command its own process group (pid == pgid) so a timeout
 *  or kill can take down everything it spawned; the marker tells the caller
 *  which group that is. `exec` keeps the pid. */
const PGRP = String.raw`perl -e 'setpgrp(0,0); print STDERR "${PGRP_MARKER}$$\n"; exec @ARGV'`;

/** Wrap a command for the remote. tailcat's SSH server runs `$SHELL -c <string>`
 *  (non-login, often zsh); we normalise to /bin/sh, or bash -l for the bash tool. */
export function wrapCommand(cmd: string, login: boolean): string {
  return `${PGRP} ${login ? "bash -lc" : "/bin/sh -c"} ${shq(cmd)}`;
}

/** Shell snippet printing a path's mtime (sub-second) — `$1`-style use: `${MTIME} <quoted path>`. */
export const MTIME = String.raw`perl -MTime::HiRes=stat -e 'my @s = stat shift; print defined $s[9] ? $s[9] : ""'`;

/** A tailcat address or a DNS name carrying one. Never starts with '-' (flag injection). */
export function isTailcatAddr(s: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{2,511}$/.test(s);
}

/** Absolute or home-relative, no control characters. */
export function isRemoteDir(s: string): boolean {
  if (!s || /[\0\n\r]/.test(s)) return false;
  return s === "~" || s.startsWith("~/") || s.startsWith("/");
}

/** File-name-safe key (session ids into remote paths). */
export function sanitizeKey(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "");
}
