/**
 * Tier `none`: today's behaviour. The sandbox resolver returns null for it, so
 * `create` is never reached; the driver exists so the tier table is complete
 * and a node configured for `none` has something to probe.
 */
import type { BoxSpec, SandboxDriver, SandboxProbe, SessionSandbox } from "../sandbox";

export const noneDriver: SandboxDriver = {
  tier: "none",
  async probe(): Promise<SandboxProbe> {
    return { ok: true };
  },
  create(_spec: BoxSpec): SessionSandbox {
    // Reaching this is a bug in the resolver: a box was resolved for a node
    // that offers no sandbox. Refuse; never hand back something that spawns
    // unboxed under a sandbox's name.
    throw new Error("box tier 'none' creates no sandbox: the resolver returns null for it");
  },
};
