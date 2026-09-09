/**
 * Capability negotiation.
 *
 * slaude's behaviours are not all equally optional. The approval gate is a
 * security control; the "compacting…" indicator is a nicety. This module makes
 * that ranking explicit so pointing slaude at a new harness either boots with a
 * printed list of what degraded, or refuses to boot at all — never silently
 * drops a control.
 */

import type { HarnessCapabilities, HookPoint } from "./types";

/** A slaude behaviour that depends on a harness capability. */
export type Feature =
  | "approval-gate"
  | "disengage-suppression"
  | "stop-guard"
  | "out-of-band-context"
  | "compaction-signal"
  | "surface-tools"
  | "persona-prompt"
  | "thread-continuity"
  | "live-multiturn"
  | "model-switch"
  | "token-budget";

/** How a feature copes when its capability is missing. */
export type Fallback =
  /** slaude emulates it outside the harness; behaviour preserved, mechanism differs. */
  | { kind: "emulate"; how: string }
  /** Behaviour is weakened but the session still runs. */
  | { kind: "degrade"; loses: string }
  /** No safe fallback — boot must fail. */
  | { kind: "none"; why: string };

type Requirement = {
  feature: Feature;
  /** Why slaude needs it, for the boot log. */
  needs: string;
  /** Returns null when satisfied, else the reason it is not. */
  check: (c: HarnessCapabilities) => string | null;
  /** Chosen against the harness that failed the check (bridging depends on it). */
  fallback: (c: HarnessCapabilities) => Fallback;
};

const has = (c: HarnessCapabilities, p: HookPoint) => c.hooks.includes(p);

const REQUIREMENTS: readonly Requirement[] = [
  {
    feature: "approval-gate",
    needs: "park a tool call on a Slack approval button and resume on the answer",
    check: (c) =>
      c.permissionGate === "callback"
        ? null
        : `permissionGate is "${c.permissionGate}", not an interactive callback`,
    // A prompt-level "please ask first" is not a gate. Anything short of an
    // interactive deny lets an unapproved tool call through, so there is no
    // fallback: refuse to boot with gating enabled.
    fallback: (c) =>
      c.permissionGate === "hook" && c.hookDecisions.deny
        ? {
            kind: "degrade",
            loses: "approval is decided by a hook and cannot block on a human — auto-deny only",
          }
        : { kind: "none", why: "no way to refuse a tool call before it executes" },
  },
  {
    feature: "surface-tools",
    needs: "mount reply/request_approval/upload/react, which close over live Slack state",
    check: (c) => (c.tools.inProcess ? null : "cannot host slaude-implemented tools in-process"),
    fallback: (c) =>
      c.tools.mcpHttp || c.tools.mcpStdio
        ? {
            kind: "emulate",
            how: `expose the toolsets over a loopback ${c.tools.mcpHttp ? "http" : "stdio"} MCP bridge that RPCs back into slaude`,
          }
        : { kind: "none", why: "no in-process tools and no MCP transport — the agent would have no way to reply to Slack" },
  },
  {
    feature: "disengage-suppression",
    needs: "record a message on a disengaged thread without running the model",
    check: (c) =>
      !has(c, "userPromptSubmit")
        ? "no userPromptSubmit hook"
        : !c.hookDecisions.halt
          ? "hook cannot halt after persisting the prompt"
          : null,
    fallback: () => ({
      kind: "degrade",
      loses:
        "the gateway drops the message before it reaches the harness — the thread transcript has no record of it, so re-engaging resumes without the gap (see field note 2026-06-16)",
    }),
  },
  {
    feature: "stop-guard",
    needs: "refuse an end-of-turn and feed the reason back (KB-first enforcement)",
    check: (c) =>
      !has(c, "turnEnd")
        ? "no turnEnd hook"
        : !c.hookDecisions.block
          ? "hook cannot block a stop and resume the model"
          : null,
    fallback: () => ({ kind: "degrade", loses: "guard becomes advisory — logged, not enforced" }),
  },
  {
    feature: "out-of-band-context",
    needs: "drain queued gate events (/model, /mode, mcp connect) into the next turn",
    check: (c) =>
      has(c, "userPromptSubmit") && c.hookDecisions.addContext ? null : "cannot inject per-turn context",
    fallback: () => ({
      kind: "emulate",
      how: "prepend the queued notes to the user message text before sending",
    }),
  },
  {
    feature: "compaction-signal",
    needs: 'show the "compacting context…" indicator in the thread',
    check: (c) => (has(c, "preCompact") ? null : "no preCompact hook"),
    fallback: () => ({ kind: "degrade", loses: "no compaction indicator" }),
  },
  {
    feature: "persona-prompt",
    needs: "append SOUL persona, channel mandate, session mode and memory blocks",
    check: (c) => (c.systemPrompt === "append" ? null : `systemPrompt is "${c.systemPrompt}"`),
    fallback: (c) =>
      c.systemPrompt === "replace"
        ? {
            kind: "emulate",
            how: "slaude supplies the whole system prompt, including its own coding-agent baseline",
          }
        : {
            kind: "emulate",
            how: "write the composed blocks to the harness's instructions file in cwd each boot",
          },
  },
  {
    feature: "thread-continuity",
    needs: "resume a Slack thread's conversation across restarts",
    check: (c) => (c.resume === "native" ? null : `resume is "${c.resume}"`),
    fallback: (c) =>
      c.resume === "replay"
        ? { kind: "emulate", how: "re-send a rolled-up transcript prefix on each boot" }
        : { kind: "degrade", loses: "every turn starts cold — no thread memory beyond injected context" },
  },
  {
    feature: "live-multiturn",
    needs: "push follow-up messages into a session mid-turn",
    check: (c) => (c.streamingInput ? null : "no streaming input"),
    fallback: () => ({ kind: "emulate", how: "queue messages and run them one turn at a time" }),
  },
  {
    feature: "model-switch",
    needs: "/model without restarting the thread",
    check: (c) => (c.liveControls.model ? null : "model is fixed for the life of a session"),
    fallback: () => ({ kind: "emulate", how: "reboot the session with the new model and resume" }),
  },
  {
    feature: "token-budget",
    needs: "context-window threshold alerts",
    check: (c) => (c.usageReporting ? null : "no usage in the event stream"),
    fallback: () => ({ kind: "degrade", loses: "no budget warnings" }),
  },
] as const;

export type Finding = {
  feature: Feature;
  needs: string;
  reason: string;
  fallback: Fallback;
};

export type Negotiation = {
  harness: string;
  /** Features that work natively. */
  native: Feature[];
  /** Features that work through a fallback — print these at boot. */
  degraded: Finding[];
  /** Features with no safe fallback. Non-empty (after opt-outs) → refuse to boot. */
  blockers: Finding[];
};

export type NegotiateOptions = {
  /**
   * Features the deployment has explicitly turned off, so a missing capability
   * is not a problem. E.g. a deploy with no approval gating may pass
   * ["approval-gate"]. Opting out of a blocker is the operator's call and must
   * be a deliberate config act, never a default.
   */
  disabled?: readonly Feature[];
};

/** Score a harness against everything slaude needs. Pure — safe to unit test. */
export function negotiate(
  caps: HarnessCapabilities,
  opts: NegotiateOptions = {},
): Negotiation {
  const disabled = new Set(opts.disabled ?? []);
  const out: Negotiation = { harness: caps.id, native: [], degraded: [], blockers: [] };
  for (const req of REQUIREMENTS) {
    if (disabled.has(req.feature)) continue;
    const reason = req.check(caps);
    if (reason === null) {
      out.native.push(req.feature);
      continue;
    }
    const finding: Finding = { feature: req.feature, needs: req.needs, reason, fallback: req.fallback(caps) };
    if (finding.fallback.kind === "none") out.blockers.push(finding);
    else out.degraded.push(finding);
  }
  return out;
}

/** Boot-log rendering for a negotiation. One line per non-native feature. */
export function formatNegotiation(n: Negotiation): string {
  const lines = [`[harness] ${n.harness}: ${n.native.length} native, ${n.degraded.length} degraded, ${n.blockers.length} blocked`];
  for (const f of n.degraded) {
    const fb = f.fallback;
    const detail =
      fb.kind === "emulate"
        ? `emulated — ${fb.how}`
        : fb.kind === "degrade"
          ? `degraded — ${fb.loses}`
          : `no fallback — ${fb.why}`;
    lines.push(`[harness]   ${f.feature}: ${f.reason}; ${detail}`);
  }
  for (const f of n.blockers) {
    const why = f.fallback.kind === "none" ? f.fallback.why : "";
    lines.push(`[harness]   ${f.feature}: BLOCKED — ${f.reason}; ${why}`);
  }
  return lines.join("\n");
}

/** Throws with a readable summary when a harness cannot host slaude safely. */
export function assertUsable(n: Negotiation): void {
  if (n.blockers.length === 0) return;
  const detail = n.blockers
    .map((b) => `  - ${b.feature}: ${b.reason} (needed to ${b.needs})`)
    .join("\n");
  throw new Error(
    `harness "${n.harness}" cannot host slaude — missing capabilities with no safe fallback:\n${detail}\n` +
      `Disable the feature explicitly if the deployment does not need it.`,
  );
}
