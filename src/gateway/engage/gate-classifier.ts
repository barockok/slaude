import type { GateRunner } from "../gate/runner";
import type { EngageCandidate, EngageClassifier } from "./types";

/**
 * The classifier backed by the decision gate. It asks the runner for an
 * implicit consult and trusts only a model answer: a `rules`/`shadow` source,
 * an undefined result (gate off, input failure, timeout) and any throw are a
 * pass. Nothing here names an adapter; which one answers is the gate's
 * configuration.
 */
export function gateClassifier(runner: GateRunner): EngageClassifier {
  return {
    async classify(c: EngageCandidate): Promise<"run" | "pass"> {
      try {
        const input = async () => ({ ...(await c.input()), implicit: c.level, continuation: c.continuation });
        // `actual` is "drop": what the gateway does today with an unmentioned message.
        const r = await runner.consult(c.key, input, "drop");
        return r !== undefined && r.source === "adapter" && r.action === "run" ? "run" : "pass";
      } catch {
        return "pass";
      }
    },
  };
}
