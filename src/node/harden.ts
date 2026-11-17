/**
 * Best-effort process hardening at node start, Linux only.
 *
 * A tool running at the node's uid could otherwise read /proc/<node pid>/environ
 * and take SLAUDE_NODE_TOKEN, then report as this node. PR_SET_DUMPABLE 0 makes
 * the kernel treat /proc/<pid>/ of this process as root's and refuses ptrace from
 * the same uid. It is reset by execve, so child processes are unaffected (and
 * their environment is already scrubbed of the token).
 *
 * This narrows the risk and does not remove it: the full guarantee of the
 * automatic portal offer needs agent tools running under a different uid from
 * the node process.
 */
import { dlopen, FFIType } from "bun:ffi";

const PR_GET_DUMPABLE = 3;
const PR_SET_DUMPABLE = 4;

export type Prctl = (option: number, arg: number) => number;

function libcPrctl(): Prctl {
  const lib = dlopen("libc.so.6", {
    prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
  });
  return (option, arg) => lib.symbols.prctl(option, arg, 0, 0, 0);
}

export function hardenNodeProcess(deps: { platform?: string; prctl?: () => Prctl; warn?: (m: string) => void } = {}): boolean {
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const fail = (why: string) => {
    warn(`[node] could not make this process non-dumpable (${why}): a tool at this node's uid may be able to read its environment`);
    return false;
  };
  const platform = deps.platform ?? process.platform;
  if (platform !== "linux") return fail(`not Linux: ${platform}`);
  try {
    const prctl = (deps.prctl ?? libcPrctl)();
    if (prctl(PR_SET_DUMPABLE, 0) !== 0) return fail("prctl refused");
    if (prctl(PR_GET_DUMPABLE, 0) !== 0) return fail("prctl did not take effect");
    return true;
  } catch (e) {
    return fail(e instanceof Error ? e.name : typeof e);
  }
}
