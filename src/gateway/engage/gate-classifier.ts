import { gateKey, type GateRunner } from "../gate/runner";
import type { ClassifierVerdict, EngageCandidate, EngageClassifier } from "./types";

/**
 * The classifier backed by the decision gate. It asks the runner for an
 * implicit consult, which answers from the configured adapter whatever the
 * deployment's gate mode, and trusts only a model answer: no adapter, an
 * error, a timeout or an input failure is a pass. The channel's own mode is
 * applied here: in shadow the adapter is still called (and the runner logs the
 * decision) but the answer is always pass. Nothing here names an adapter.
 */
export function gateClassifier(runner: GateRunner): EngageClassifier {
  async function verdict(c: EngageCandidate): Promise<ClassifierVerdict> {
    try {
      const key = gateKey({ channel: c.channel, ts: c.ts, persona: c.persona, app: c.app, continuation: c.continuation, implicit: c.level });
      const input = async () => ({ ...(await c.input()), engaged: false, implicit: c.level, continuation: c.continuation });
      // A shadow candidate is never acted on: it is counted by the engage counters, not as a gate decision.
      const r = await runner.consultImplicit(key, input, { level: c.level, continuation: c.continuation, quiet: c.mode === "shadow" });
      if (r === undefined) return { answer: "pass", reason: "input" };
      if (r.source !== "adapter") return { answer: "pass", reason: r.why ?? "error" };
      return { answer: r.action === "run" ? "run" : "pass", reason: "answer" };
    } catch {
      return { answer: "pass", reason: "error" };
    }
  }
  return {
    async classify(c: EngageCandidate): Promise<"run" | "pass"> {
      const v = await verdict(c);
      return c.mode === "on" ? v.answer : "pass";
    },
    classifyDetailed: verdict,
  };
}
