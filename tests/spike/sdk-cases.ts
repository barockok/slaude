/**
 * The SDK pin cases, run in their own process: other test files replace the
 * SDK module with mock.module (process-wide in Bun), so the pins must not
 * share a process with them. `bun tests/spike/sdk-cases.ts` prints one JSON
 * object, case name to result; tests/spike/sdk-hooks.test.ts asserts on it.
 */
import type { HookCallback, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { spikeRun, type SpikeRun } from "./sdk-run";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const decide = (d: "deny" | "allow" | "ask", reason = "spike"): HookJSONOutput => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: d, permissionDecisionReason: reason },
});
const slow = (ms: number, out: HookJSONOutput): HookCallback => async () => {
  await sleep(ms);
  return out;
};

export type CaseResult = SpikeRun & { aborted?: boolean; reason?: string };

export const CASES: Record<string, () => Promise<CaseResult>> = {
  awaitDeny: () => spikeRun({ permissionMode: "bypassPermissions", preToolUse: [{ timeout: 30, hooks: [slow(2500, decide("deny", "held: denied"))] }] }),
  pastTimeout: async () => {
    let aborted = false;
    const hook: HookCallback = async (_i, _id, { signal }) => {
      signal.addEventListener("abort", () => (aborted = true));
      await sleep(4000);
      return decide("allow");
    };
    const r = await spikeRun({ permissionMode: "bypassPermissions", preToolUse: [{ timeout: 1, hooks: [hook] }] });
    return { ...r, aborted };
  },
  thrown: () => spikeRun({ permissionMode: "bypassPermissions", preToolUse: [{ hooks: [async () => { throw new Error("boom"); }] }] }),
  concurrentDeny: () => spikeRun({ permissionMode: "bypassPermissions", preToolUse: [{ timeout: 30, hooks: [slow(1500, decide("allow")), async () => decide("deny", "other hook")] }] }),
  allowSkipsCanUseTool: () => spikeRun({ permissionMode: "default", canUseTool: async () => ({ behavior: "deny", message: "second card" }), preToolUse: [{ hooks: [async () => decide("allow")] }] }),
  askUnderBypass: async () => {
    let reason: string | undefined;
    const r = await spikeRun({
      permissionMode: "bypassPermissions",
      canUseTool: async (_n, _i, ctx) => {
        reason = ctx.decisionReason;
        return { behavior: "deny", message: "card says no" };
      },
      preToolUse: [{ hooks: [async () => decide("ask", "owner rule")] }],
    });
    return { ...r, ...(reason ? { reason } : {}) };
  },
};

if (import.meta.main) {
  const out: Record<string, CaseResult | { error: string }> = {};
  await Promise.all(Object.entries(CASES).map(async ([k, run]) => {
    try {
      out[k] = await run();
    } catch (e) {
      out[k] = { error: e instanceof Error ? e.message : String(e) };
    }
  }));
  console.log(JSON.stringify(out));
}
