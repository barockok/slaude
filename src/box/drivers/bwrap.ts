/**
 * The bwrap tier on Linux: namespaces, a seccomp filter and no capability, on
 * the HOST kernel (box spec, "Sandbox tiers"). Everything above the sandbox is
 * the gVisor tier's: the same image, home, mounts, proxies, packs and limits,
 * through the same supervisor and the same driver (./supervised.ts).
 *
 * What differs, and what an operator choosing this tier accepts:
 *   - the kernel is shared with the node. A kernel bug reachable from a box is
 *     a way out of it; gVisor's user-space kernel is what removes that;
 *   - a box's processes run under the supervisor's uid (root) mapped to the
 *     agent's inside a user namespace with no capability, so its files are
 *     root's on the node's disk;
 *   - the root overlay is a kernel overlay mount on the node's disk and has no
 *     size limit of its own;
 *   - there is no long-lived sandbox process: each process the worker starts
 *     is its own bwrap, so nothing an agent leaves running outlives its CLI.
 *
 * The macOS variant (Seatbelt through sandbox-runtime) is not built here.
 */
import { makeSupervisedDriver, type SupervisedDriver, type SupervisedDriverDeps } from "./supervised";

export function makeBwrapDriver(deps: SupervisedDriverDeps): SupervisedDriver {
  return makeSupervisedDriver("bwrap", deps);
}
