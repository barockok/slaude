import type { Transport, WebClientLike } from "../core/transport";
import type {
  CanUseTool,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import { env } from "../../config/env";
import * as PendingGates from "../../db/pending-gates";
import { defaultGateBus, type GateBus } from "../../queue/gate-bus";

type PendingKey = string; // toolUseID

/** Durable-row deadline for a permission prompt. Orphans (dead process) drain
 *  via sweepExpired at this horizon; a live waiter that outlasts it is denied
 *  on the next click or torn down by the turn's abort signal. */
export const PERM_GATE_TTL_MS = 60 * 60 * 1000;
type Pending = {
  channel: string;
  threadTs: string;
  messageTs: string;
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  resolve: (r: Awaited<ReturnType<CanUseTool>>) => void;
  /** gate-bus unsubscribe, when a bus is configured. */
  unsub?: () => Promise<void>;
};

export type PermissionDecision = Awaited<ReturnType<CanUseTool>>;

/** Comma-separated SLAUDE_AUTO_ALLOW_TOOLS → set. Shared by gateway + node. */
export function autoAllowFromEnv(): Set<string> {
  return new Set(
    (process.env.SLAUDE_AUTO_ALLOW_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Static permission policy — every short-circuit that never needs a human.
 * Returns the decision, or null when a prompt is required. Pure over its
 * inputs so the node-side permissionResolver applies the IDENTICAL policy
 * before spending a REST round-trip (and the gateway re-applies it on the
 * can_use_tool endpoint — defense in depth against a divergent node).
 */
export function permissionPolicy(
  toolName: string,
  input: Record<string, unknown>,
  autoAllow: Set<string>,
): PermissionDecision | null {
  if (autoAllow.has(toolName)) {
    return { behavior: "allow", updatedInput: input };
  }
  // Hard-deny the runtime/SDK-synthesized OAuth bootstrap tools. MCP OAuth must
  // only ever start through our deterministic engine (`/mcp connect` or the
  // mcp__slaude_connect__ tool), which owns the loopback, signed-state redirect,
  // URL-safe out-of-band post, and redact-teardown. The synthesized path uses an
  // uncontrolled redirect and would launder the auth URL — never let it run, and
  // never even prompt the user to approve it.
  if (/^mcp__.+__(authenticate|complete_authentication)$/.test(toolName)) {
    return { behavior: "deny", message: "OAuth connect must go through `/mcp connect` (or ask me to connect it) — the synthesized auth tool is disabled." };
  }
  // Our own connect tool is the controlled entry point — never gate it (it only
  // posts an authorize link; nothing is granted until the user clicks + approves).
  if (toolName.startsWith("mcp__slaude_connect__")) {
    return { behavior: "allow", updatedInput: input };
  }
  // Surface (interaction) + runtime (control-plane) + the legacy slack namespace are
  // the agent's path to user output / housekeeping — never gate. Surface reply/edit/
  // upload especially MUST stay un-gated or every message would prompt for approval.
  if (
    toolName.startsWith("mcp__slaude_surface__") ||
    toolName.startsWith("mcp__slaude_runtime__") ||
    toolName.startsWith("mcp__slaude_slack__")
  ) {
    return { behavior: "allow", updatedInput: input };
  }
  // Skill introspection is read-only — auto-allow so evolution checks
  // don't spam the user. Write/delete still flow through approval.
  if (
    toolName === "mcp__slaude_skills__list_skills" ||
    toolName === "mcp__slaude_skills__read_skill"
  ) {
    return { behavior: "allow", updatedInput: input };
  }
  // Session introspection (token budget) is pure read — agent uses it to
  // decide whether to summarize and reset. Never gate.
  if (toolName.startsWith("mcp__slaude_session__")) {
    return { behavior: "allow", updatedInput: input };
  }
  // KB introspection is read-only — agent uses it to discover and read
  // knowledge bases without spamming the user.
  if (toolName.startsWith("mcp__slaude_kb__")) {
    return { behavior: "allow", updatedInput: input };
  }
  return null;
}

/**
 * Build the "always allow" permission updates from the SDK's suggestions
 * (they encode the specific pattern, e.g. Bash(ls:*)), falling back to a
 * tool-wide session allow rule. Shared by the in-process click path and the
 * node-side long-poll mapping.
 */
export function alwaysAllowUpdates(
  toolName: string,
  suggestions: PermissionUpdate[] | undefined,
): PermissionUpdate[] {
  if (suggestions && suggestions.length > 0) return [...suggestions];
  return [
    {
      type: "addRules",
      rules: [{ toolName }],
      behavior: "allow",
      destination: "session",
    },
  ];
}

/** Map a settled pending_gates perm row to the SDK decision. Used by the
 *  gate-bus waiter wakeup here and by the node's long-poll resolver. */
export function decisionFromPermRow(
  row: { status: string; resolvedBy: string | null; payload: Record<string, unknown> },
  toolName: string,
  input: Record<string, unknown>,
  suggestions: PermissionUpdate[] | undefined,
): PermissionDecision {
  if (row.status === "approved") {
    const always = (row.payload as any)?.decision === "always";
    return {
      behavior: "allow",
      updatedInput: input,
      ...(always ? { updatedPermissions: alwaysAllowUpdates(toolName, suggestions) } : {}),
    };
  }
  if (row.status === "denied") {
    return { behavior: "deny", message: `Denied by <@${row.resolvedBy ?? "unknown"}>` };
  }
  return { behavior: "deny", message: row.status === "expired" ? "expired before a decision" : "cancelled" };
}

function permBlocks(toolName: string, input: Record<string, unknown>, toolUseId: string, decisionReason?: string) {
  const inputPreview = truncate(JSON.stringify(input, null, 2), 2500);
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `:lock: *Approval needed* — \`${toolName}\`` },
    },
    ...(decisionReason
      ? [
          {
            type: "context",
            elements: [{ type: "mrkdwn", text: `_${decisionReason}_` }],
          },
        ]
      : []),
    {
      type: "section",
      text: { type: "mrkdwn", text: "```\n" + inputPreview + "\n```" },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Allow once" },
          action_id: `slaude_perm:allow:${toolUseId}`,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Always allow" },
          action_id: `slaude_perm:always:${toolUseId}`,
        },
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: "Deny" },
          action_id: `slaude_perm:deny:${toolUseId}`,
        },
      ],
    },
  ];
}

/**
 * Slack approval gate. When the SDK asks for a tool permission, we post a
 * Block Kit message to the active session's thread with Allow / Always /
 * Deny buttons, then resolve the SDK promise on the user's click.
 *
 * Durable state: every prompt writes a pending_gates row (kind 'perm') and a
 * click settles it through the repo's status='pending' guarded UPDATE, so a
 * duplicate or cross-replica click loses cleanly.
 *
 * Wakeups (spec §5 "Interactions across replicas"): every winning click also
 * publishes `gate:<id>` on the gate bus (when Redis is configured), so
 *   - a sibling replica holding the in-process SDK waiter delivers it, and
 *   - a node long-polling /v1/pending/:id wakes instantly.
 * Rows opened for node workers (`open()`, payload.waiter='poll') have no
 * in-process waiter anywhere — ANY replica's click settles them. Without a
 * bus, foreign in-process rows keep the conservative "pending on another
 * replica" answer, exactly as before.
 *
 * Pre-approved tools (env SLAUDE_AUTO_ALLOW_TOOLS, comma-separated) return
 * allow without prompting — useful for safe read-only ops like Read/Grep/Glob.
 */
export class PermissionGate {
  #client: WebClientLike;
  #autoAllow: Set<string>;
  /** sessionId → channel/thread for routing the prompt. */
  #routes = new Map<string, { channel: string; threadTs: string }>();
  #pending = new Map<PendingKey, Pending>();
  /** Explicit bus override (tests/sim); undefined = env-driven default. */
  #busOverride: GateBus | null | undefined;

  constructor(transport: Transport, opts: { gateBus?: GateBus | null } = {}) {
    this.#client = transport.client;
    this.#busOverride = opts.gateBus;
    this.#autoAllow = autoAllowFromEnv();

    transport.action(
      /^slaude_perm:(allow|always|deny):.+$/,
      async ({ ack, action, body, respond }) => {
        await ack();
        const a = action as { action_id: string };
        const m = a.action_id.match(/^slaude_perm:(allow|always|deny):(.+)$/);
        if (!m) return;
        const decision = m[1] as "allow" | "always" | "deny";
        const toolUseId = m[2]!;
        const userId = (body as any).user?.id ?? "unknown";
        const status = decision === "deny" ? ("denied" as const) : ("approved" as const);
        const stale = async () => {
          // Already decided (duplicate click, expiry, abort, or another
          // replica won). Make sure the buttons go away by replacing the
          // message via the click's response_url.
          try {
            await respond({
              replace_original: true,
              text: `:lock: \`${a.action_id.split(":")[2]}\` already decided`,
              blocks: [],
            });
          } catch {}
        };
        const decidedText = (toolName: string) => {
          const decided =
            decision === "allow"
              ? "*Allowed* once"
              : decision === "always"
                ? "*Always-allowed* for this session"
                : "*Denied*";
          return `${toolName} → ${decided} by <@${userId}>`;
        };
        const pend = this.#pending.get(toolUseId);
        if (!pend) {
          const cur = await PendingGates.get(toolUseId);
          if (!cur || cur.status !== "pending") return void (await stale());
          const isPollRow = (cur.payload as any)?.waiter === "poll";
          if (!isPollRow && cur.instanceId === PendingGates.INSTANCE_ID) {
            // Our own in-process row with no waiter: the abort raced the
            // click. Settle the stray so it doesn't linger until expiry.
            await PendingGates.resolve(toolUseId, "cancelled", userId);
            await this.#publish(toolUseId);
            return void (await stale());
          }
          const bus = this.#bus();
          if (isPollRow || bus) {
            // poll row: the waiter is a node long-poll — any replica decides.
            // foreign in-process row + bus: the sibling's subscription wakes
            // its waiter, so deciding here is safe (spec §5).
            const row = await PendingGates.resolve(toolUseId, status, userId, { decision });
            if (!row) return void (await stale());
            await this.#publish(toolUseId);
            try {
              await respond({
                replace_original: true,
                text: decidedText(String((cur.payload as any)?.toolName ?? "tool")),
                blocks: [],
              });
            } catch {}
            return;
          }
          // Foreign pending row and no bus: a sibling replica may be alive and
          // holding the waiter with no way to wake it from here — never cancel
          // it. Tell the clicker where the gate lives and keep the buttons.
          try {
            await respond({
              response_type: "ephemeral",
              replace_original: false,
              text: ":hourglass: This approval is pending on another replica — it will be decided there (or auto-expire).",
            });
          } catch {}
          return;
        }
        // DB row is the source of truth: exactly one click wins the guarded
        // UPDATE; every later click sees null and is stale. The decision
        // granularity (allow vs always) rides along in the payload so
        // long-pollers and bus-woken siblings can honor "always".
        const row = await PendingGates.resolve(toolUseId, status, userId, { decision });
        if (!row) {
          // A sweep may have expired (or an abort cancelled) the row while the
          // waiter is still alive — deliver the deny locally, never hang.
          const cur = await PendingGates.get(toolUseId);
          if (cur && (cur.status === "expired" || cur.status === "cancelled") && this.#pending.delete(toolUseId)) {
            void pend.unsub?.().catch(() => {});
            pend.resolve({ behavior: "deny", message: cur.status === "expired" ? "expired before a decision" : "cancelled" });
          }
          return void (await stale());
        }
        this.#pending.delete(toolUseId);
        void pend.unsub?.().catch(() => {});
        await this.#publish(toolUseId);

        // Use respond() — fires against the click's response_url and is much
        // faster than chat.update, so the buttons disappear before the user
        // has a chance to double-click.
        try {
          await respond({
            replace_original: true,
            text: decidedText(pend.toolName),
            blocks: [],
          });
        } catch (e) {
          console.error("[permission-gate] respond failed", e);
        }

        if (decision === "deny") {
          pend.resolve({ behavior: "deny", message: `Denied by <@${userId}>` });
          return;
        }

        pend.resolve({
          behavior: "allow",
          updatedInput: pend.input,
          ...(decision === "always"
            ? { updatedPermissions: alwaysAllowUpdates(pend.toolName, pend.suggestions) }
            : {}),
        });
      },
    );
  }

  #bus(): GateBus | null {
    return this.#busOverride !== undefined ? this.#busOverride : defaultGateBus();
  }

  async #publish(id: string): Promise<void> {
    try {
      await this.#bus()?.publish(id);
    } catch (e) {
      console.error("[permission-gate] gate publish failed", e);
    }
  }

  /** Adapter calls this when it knows where a session lives in Slack. */
  bindSession(sessionId: string, channel: string, threadTs: string) {
    this.#routes.set(sessionId, { channel, threadTs });
  }

  unbindSession(sessionId: string) {
    this.#routes.delete(sessionId);
  }

  /**
   * Non-blocking open for the REST tool plane (spec §3 "Blocking tools"):
   * apply the static policy; when a human is needed, write the durable row
   * (payload.waiter='poll' — the waiter is the node's /v1/pending long-poll,
   * so no replica registers an in-process one) and post the card. Returns
   * either the immediate decision or the pendingId to long-poll.
   */
  async open(args: {
    sessionId: string;
    toolName: string;
    input: Record<string, unknown>;
    toolUseId: string;
    channel: string;
    threadTs: string;
    decisionReason?: string;
    suggestions?: unknown[];
  }): Promise<{ decision: PermissionDecision } | { pendingId: string }> {
    const policy = permissionPolicy(args.toolName, args.input, this.#autoAllow);
    if (policy) return { decision: policy };

    await PendingGates.create({
      id: args.toolUseId,
      kind: "perm",
      sessionId: args.sessionId,
      payload: {
        toolName: args.toolName,
        channel: args.channel,
        threadTs: args.threadTs,
        waiter: "poll",
        ...(args.suggestions?.length ? { suggestions: args.suggestions } : {}),
      },
      expiresAt: Date.now() + PERM_GATE_TTL_MS,
    });
    try {
      await this.#client.chat.postMessage({
        channel: args.channel,
        thread_ts: args.threadTs,
        text: `:lock: Approval needed: \`${args.toolName}\``,
        blocks: permBlocks(args.toolName, args.input, args.toolUseId, args.decisionReason),
      });
    } catch (e) {
      // The prompt never reached Slack — settle the row and rethrow.
      await PendingGates.resolve(args.toolUseId, "cancelled", "system").catch(() => {});
      throw e;
    }
    return { pendingId: args.toolUseId };
  }

  /** Closure passed into AgentManager.setPermissionResolver. */
  resolver: import("../../agent/manager").PermissionResolver = async (
    sessionId,
    toolName,
    input,
    ctx,
  ) => {
    const policy = permissionPolicy(toolName, input, this.#autoAllow);
    if (policy) return policy;
    const route = this.#routes.get(sessionId);
    if (!route) {
      // No live thread — fail closed so we don't silently grant ops.
      return { behavior: "deny", message: "no active slaude thread to ask in" };
    }

    const toolUseId = ctx.toolUseID;

    // Durable pending state FIRST, then the in-process waiter, then the
    // buttons: by the time a click can exist, both stores are in place — no
    // window where a click finds half-initialized state.
    await PendingGates.create({
      id: toolUseId,
      kind: "perm",
      sessionId,
      payload: { toolName, channel: route.channel, threadTs: route.threadTs },
      expiresAt: Date.now() + PERM_GATE_TTL_MS,
    });

    let resolveFn!: (r: Awaited<ReturnType<CanUseTool>>) => void;
    const promise = new Promise<Awaited<ReturnType<CanUseTool>>>((resolve) => {
      resolveFn = resolve;
    });
    const pend: Pending = {
      channel: route.channel,
      threadTs: route.threadTs,
      messageTs: "",
      toolName,
      input,
      suggestions: ctx.suggestions,
      resolve: resolveFn,
    };
    this.#pending.set(toolUseId, pend);
    // Cross-replica wakeup: a click landing on a sibling replica resolves the
    // row and publishes; this subscription delivers the SDK promise here.
    const bus = this.#bus();
    if (bus) {
      try {
        pend.unsub = await bus.subscribe(toolUseId, () => {
          void (async () => {
            const cur = await PendingGates.get(toolUseId);
            if (!cur || cur.status === "pending") return;
            if (!this.#pending.delete(toolUseId)) return; // local click already delivered
            void pend.unsub?.().catch(() => {});
            pend.resolve(decisionFromPermRow(cur, toolName, input, ctx.suggestions));
          })();
        });
      } catch (e) {
        console.error("[permission-gate] gate subscribe failed (falling back to click-only)", e);
      }
    }
    // Honor abort signal — tear down the prompt and deny.
    ctx.signal.addEventListener(
      "abort",
      () => {
        if (!this.#pending.has(toolUseId)) return;
        this.#pending.delete(toolUseId);
        void pend.unsub?.().catch(() => {});
        // Settle the durable row too; a click that raced the abort loses.
        void PendingGates.resolve(toolUseId, "cancelled", "system").catch(() => {});
        resolveFn({ behavior: "deny", message: "aborted" });
      },
      { once: true },
    );

    try {
      const posted = await this.#client.chat.postMessage({
        channel: route.channel,
        thread_ts: route.threadTs,
        text: `:lock: Approval needed: \`${toolName}\``,
        blocks: permBlocks(toolName, input, toolUseId, ctx.decisionReason),
      });
      pend.messageTs = (posted.ts as string) ?? "";
    } catch (e) {
      // The prompt never reached Slack — tear both stores down and rethrow.
      this.#pending.delete(toolUseId);
      void pend.unsub?.().catch(() => {});
      void PendingGates.resolve(toolUseId, "cancelled", "system").catch(() => {});
      throw e;
    }

    return promise;
  };
}

function truncate(s: string, max: number) {
  return s.length <= max ? s : s.slice(0, max) + "\n…(truncated)";
}

// silence unused-import warning
void env;
