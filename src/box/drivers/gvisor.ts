/**
 * The gVisor tier: a user-space kernel (runsc) between the agent and the host
 * kernel (box spec, "The gVisor configuration"). The sandbox itself is made by
 * the box supervisor; this is its driver on the node worker's side, which the
 * bwrap tier shares (./supervised.ts).
 */
import { makeSupervisedDriver, type SupervisedDriver, type SupervisedDriverDeps } from "./supervised";

export function makeGvisorDriver(deps: SupervisedDriverDeps): SupervisedDriver {
  return makeSupervisedDriver("gvisor", deps);
}
