import { gateKey, type GateRunner } from "../gate/runner";
import type { EngageCandidate, EngageClassifier } from "./types";

/**
 * The classifier backed by the decision gate. It asks the runner for an
 * implicit consult, which answers from the configured adapter whatever the
 * deployment's gate mode, and trusts only a model answer: no adapter, an
 * error, a timeout or an input failure is a pass. The channel's own mode is
 * applied here: in shadow the adapter is still called (and the runner logs the
 * decision) but the answer is always pass. Nothing here names an adapter.
 */
export function gateClassifier(runner: GateRunner): EngageClassifier {
  return {
    async classify(c: EngageCandidate): Promise<"run" | "pass"> {
      try {
        const key = gateKey({ channel: c.channel, ts: c.ts, persona: c.persona, app: c.app, continuation: c.continuation, implicit: c.level });
        const input = async () => ({ ...(await c.input()), engaged: false, implicit: c.level, continuation: c.continuation });
        const r = await runner.consultImplicit(key, input, { level: c.level, continuation: c.continuation });
        const answer = r !== undefined && r.source === "adapter" && r.action === "run" ? "run" : "pass";
        return c.mode === "on" ? answer : "pass";
      } catch {
        return "pass";
      }
    },
  };
}
