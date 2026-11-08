/**
 * Pins of the agent SDK's PreToolUse behaviour that owner tool `approve`
 * rests on (spike, docs/superpowers/specs/2026-11-08-owner-guardrails-a2-spike.md).
 * Each case runs the real Claude Code CLI through query() against a local
 * fake of the Messages API: the model calls Bash once (`touch <marker>`).
 * The cases run in a child process (tests/spike/sdk-cases.ts), clear of the
 * SDK mocks other test files install. An SDK upgrade that changes any of
 * these fails here first.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import type { CaseResult } from "./sdk-cases";

let r: Record<string, CaseResult>;
beforeAll(async () => {
  const p = Bun.spawn(["bun", "tests/spike/sdk-cases.ts"], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  if (code !== 0) throw new Error(`spike cases exited ${code}: ${await new Response(p.stderr).text()}`);
  r = JSON.parse(out.trim().split("\n").pop()!);
}, 90_000);

describe("SDK PreToolUse pins (owner tool approve)", () => {
  test("a hook that awaits (a card) inside its matcher timeout decides: its deny is honoured", () => {
    expect(r.awaitDeny!.ran).toBe(false);
    expect(r.awaitDeny!.toolResults).toEqual(["held: denied"]);
  });

  test("past the matcher timeout the hook's signal aborts and the tool does not run (no fall-through allow)", () => {
    expect(r.pastTimeout!.aborted).toBe(true);
    expect(r.pastTimeout!.ran).toBe(false);
  });

  test("a hook that throws falls through: the tool runs (so the guardrail hook must never throw)", () => {
    expect(r.thrown!.ran).toBe(true);
  });

  test("a deny from one hook wins over a slower allow from another (hooks run concurrently)", () => {
    expect(r.concurrentDeny!.ran).toBe(false);
    expect(r.concurrentDeny!.toolResults).toEqual(["other hook"]);
  });

  test("an allow from the hook skips canUseTool (one card, not two, in default mode)", () => {
    expect(r.allowSkipsCanUseTool!.ran).toBe(true);
    expect(r.allowSkipsCanUseTool!.canUseToolCalls).toBe(0);
  });

  test("the rejected alternative: ask reaches canUseTool even under bypassPermissions", () => {
    expect(r.askUnderBypass!.canUseToolCalls).toBe(1);
    expect(r.askUnderBypass!.reason).toBe("owner rule");
    expect(r.askUnderBypass!.ran).toBe(false);
  });
});
