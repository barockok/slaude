/**
 * Pins of the agent SDK's PreToolUse behaviour that owner tool `approve`
 * rests on (spike, docs/superpowers/specs/2026-11-08-owner-guardrails-a2-spike.md).
 * Each test runs the real Claude Code CLI through query() against a local
 * fake of the Messages API: the model calls Bash once (`touch <marker>`).
 * An SDK upgrade that changes any of these fails here first.
 */
import { describe, expect, test } from "bun:test";
import type { HookCallback, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { spikeRun } from "./sdk-run";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const decide = (d: "deny" | "allow" | "ask", reason = "spike"): HookJSONOutput => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: d, permissionDecisionReason: reason },
});
const slow = (ms: number, out: HookJSONOutput): HookCallback => async () => {
  await sleep(ms);
  return out;
};

describe("SDK PreToolUse pins (owner tool approve)", () => {
  test("a hook that awaits (a card) inside its matcher timeout decides: its deny is honoured", async () => {
    const r = await spikeRun({ permissionMode: "bypassPermissions", preToolUse: [{ timeout: 30, hooks: [slow(2500, decide("deny", "held: denied"))] }] });
    expect(r.ran).toBe(false);
    expect(r.toolResults).toEqual(["held: denied"]);
  }, 60_000);

  test("past the matcher timeout the hook's signal aborts and the tool does not run (no fall-through allow)", async () => {
    let aborted = false;
    const hook: HookCallback = async (_i, _id, { signal }) => {
      signal.addEventListener("abort", () => (aborted = true));
      await sleep(4000);
      return decide("allow");
    };
    const r = await spikeRun({ permissionMode: "bypassPermissions", preToolUse: [{ timeout: 1, hooks: [hook] }] });
    expect(aborted).toBe(true);
    expect(r.ran).toBe(false);
  }, 60_000);

  test("a hook that throws falls through: the tool runs (so the guardrail hook must never throw)", async () => {
    const r = await spikeRun({ permissionMode: "bypassPermissions", preToolUse: [{ hooks: [async () => { throw new Error("boom"); }] }] });
    expect(r.ran).toBe(true);
  }, 60_000);

  test("a deny from one hook wins over a slower allow from another (hooks run concurrently)", async () => {
    const r = await spikeRun({
      permissionMode: "bypassPermissions",
      preToolUse: [{ timeout: 30, hooks: [slow(1500, decide("allow")), async () => decide("deny", "other hook")] }],
    });
    expect(r.ran).toBe(false);
    expect(r.toolResults).toEqual(["other hook"]);
  }, 60_000);

  test("an allow from the hook skips canUseTool (one card, not two, in default mode)", async () => {
    const r = await spikeRun({
      permissionMode: "default",
      canUseTool: async () => ({ behavior: "deny", message: "second card" }),
      preToolUse: [{ hooks: [async () => decide("allow")] }],
    });
    expect(r.ran).toBe(true);
    expect(r.canUseToolCalls).toBe(0);
  }, 60_000);

  test("the rejected alternative: ask reaches canUseTool even under bypassPermissions", async () => {
    let reason: string | undefined;
    const r = await spikeRun({
      permissionMode: "bypassPermissions",
      canUseTool: async (_n, _i, ctx) => {
        reason = ctx.decisionReason;
        return { behavior: "deny", message: "card says no" };
      },
      preToolUse: [{ hooks: [async () => decide("ask", "owner rule")] }],
    });
    expect(r.canUseToolCalls).toBe(1);
    expect(reason).toBe("owner rule");
    expect(r.ran).toBe(false);
  }, 60_000);
});
