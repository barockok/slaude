/**
 * The node's must-reply Stop guard (src/node/stop-guard.ts): the same rule
 * and text as mono's, fed from the node manager's toolCall events, reset per
 * job, and never forcing a turn mono would not force.
 */
import { describe, expect, test } from "bun:test";
import { makeNodeStopGuard, mustReplyApplies } from "../../src/node/stop-guard";
import { MUST_REPLY_INSTRUCTION, mustReplyEffect } from "../../src/agent/must-reply";

const S = "sess-1";
const slack = { claims: { origin: "slack" as const } };
const call = (tool: string, extra: Record<string, unknown> = {}) => ({ type: "toolCall" as const, sessionId: S, tool, input: {}, ...extra });

function guardWith(voice = new Set<string>()) {
  return makeNodeStopGuard({ voiceActive: (id) => voice.has(id) });
}

describe("node Stop guard", () => {
  test("a person's turn that ends without a reply is sent back with mono's instruction", () => {
    const g = guardWith();
    g.beginTurn(S, slack);
    expect(g.guard(S)).toBe(MUST_REPLY_INSTRUCTION);
  });

  test("a reply, an edit or an upload (surface or the deprecated slack namespace) lets the stop through", () => {
    for (const tool of ["mcp__slaude_surface__reply", "mcp__slaude_surface__edit", "mcp__slaude_surface__upload", "mcp__slaude_slack__reply"]) {
      const g = guardWith();
      g.beginTurn(S, slack);
      g.onEvent(call(tool));
      expect(g.guard(S)).toBeNull();
    }
  });

  test("a pass lets the stop through; a reaction or another tool does not", () => {
    const g = guardWith();
    g.beginTurn(S, slack);
    g.onEvent(call("mcp__slaude_surface__react"));
    g.onEvent(call("Bash"));
    expect(g.guard(S)).toBe(MUST_REPLY_INSTRUCTION);
    g.onEvent(call("mcp__slaude_surface__pass"));
    expect(g.guard(S)).toBeNull();
  });

  test("a panel turn is guarded like a Slack one", () => {
    const g = guardWith();
    g.beginTurn(S, { claims: { origin: "panel" } });
    expect(g.guard(S)).toBe(MUST_REPLY_INSTRUCTION);
  });

  test("cron, background runs and wakes are never forced (mono's silent routes)", () => {
    const turns = [
      { claims: { origin: "cron" as const } },
      { claims: { origin: "cron" as const, bgRun: "run-1" } },
      { claims: { origin: "cron" as const, bgRun: "run-1", wake: true } },
      // The job payload alone also marks a background run or a wake.
      { claims: { origin: "slack" as const }, bgRun: "run-1" },
      { claims: { origin: "slack" as const }, wake: { maxTurns: 3 } },
      // An absent origin (an older gateway) or an unreadable token is not known to be a person's turn.
      { claims: {} },
      { claims: null },
    ];
    for (const t of turns) {
      expect(mustReplyApplies(t)).toBe(false);
      const g = guardWith();
      g.beginTurn(S, t);
      expect(g.guard(S)).toBeNull();
    }
  });

  test("spoke and passed reset when the next job's turn starts", () => {
    const g = guardWith();
    g.beginTurn(S, slack);
    g.onEvent(call("mcp__slaude_surface__reply"));
    expect(g.guard(S)).toBeNull();
    g.beginTurn(S, slack);
    expect(g.guard(S)).toBe(MUST_REPLY_INSTRUCTION);
    g.onEvent(call("mcp__slaude_surface__pass"));
    expect(g.guard(S)).toBeNull();
    g.beginTurn(S, slack);
    expect(g.guard(S)).toBe(MUST_REPLY_INSTRUCTION);
  });

  test("a cron job after a person's turn on the same session is not forced, and the other way round", () => {
    const g = guardWith();
    g.beginTurn(S, { claims: { origin: "cron" } });
    expect(g.guard(S)).toBeNull();
    g.beginTurn(S, slack);
    expect(g.guard(S)).toBe(MUST_REPLY_INSTRUCTION);
  });

  test("voice turns are skipped, and a voice turn's reply does not count", () => {
    const voice = new Set<string>([S]);
    const g = guardWith(voice);
    g.beginTurn(S, slack);
    expect(g.guard(S)).toBeNull();
    g.onEvent(call("mcp__slaude_surface__reply"));
    voice.clear();
    expect(g.guard(S)).toBe(MUST_REPLY_INSTRUCTION);
  });

  test("the skill-evolution turn's tools do not satisfy the turn", () => {
    const g = guardWith();
    g.beginTurn(S, slack);
    g.onEvent(call("mcp__slaude_surface__reply", { autoEvolve: true }));
    expect(g.guard(S)).toBe(MUST_REPLY_INSTRUCTION);
  });

  test("a session with no job seen, or one forgotten, is not guarded; other sessions are separate", () => {
    const g = guardWith();
    expect(g.guard(S)).toBeNull();
    g.beginTurn(S, slack);
    g.beginTurn("sess-2", slack);
    g.onEvent(call("mcp__slaude_surface__reply"));
    expect(g.guard(S)).toBeNull();
    expect(g.guard("sess-2")).toBe(MUST_REPLY_INSTRUCTION);
    g.forget("sess-2");
    expect(g.guard("sess-2")).toBeNull();
  });
});

describe("the shared must-reply rule", () => {
  test("names the same tools mono counted", () => {
    expect(mustReplyEffect("mcp__slaude_surface__pass")).toBe("passed");
    for (const t of ["reply", "edit", "upload"]) {
      expect(mustReplyEffect(`mcp__slaude_surface__${t}`)).toBe("spoke");
      expect(mustReplyEffect(`mcp__slaude_slack__${t}`)).toBe("spoke");
    }
    expect(mustReplyEffect("mcp__slaude_slack__pass")).toBeNull();
    expect(mustReplyEffect("mcp__slaude_surface__react")).toBeNull();
  });

  test("the gateway and the node both use it (no second copy of the text or the tool list)", async () => {
    const { readFileSync } = await import("node:fs");
    const gw = readFileSync(new URL("../../src/gateway/core/gateway.ts", import.meta.url), "utf8");
    expect(gw).toContain("return MUST_REPLY_INSTRUCTION;");
    expect(gw).toContain("mustReplyEffect(e.tool)");
    expect(gw).not.toContain("You ended the turn without a reply");
  });
});
