/**
 * Node-side permission resolver (spec §6): the SAME static policy the
 * gateway's PermissionGate applies runs locally first (no wire hop for the
 * always-allowed namespaces); anything needing a human goes through
 * POST /v1/tools/runtime/can_use_tool → {pendingId} → long-poll
 * /v1/pending/:id, honoring the click's allow-vs-always decision recorded in
 * the row payload. Fail closed: any wire failure is a deny, never a hang.
 *
 * A wake's turn is refused first, before that local policy: nobody is in a
 * wake's turn to click a card, and mono denies every canUseTool call during a
 * wake before any policy runs (src/gateway/core/gateway.ts). Without this, a
 * tool in the node's SLAUDE_AUTO_ALLOW_TOOLS would run in a wake.
 *
 * An owner guardrail's approve rule (ctx.ownerApproval, set by the owner
 * guardrails hook) skips the local policy's allows (its denies still hold) and asks the gateway with
 * force_card and rule_id; the gateway re-evaluates the rule from its own
 * verified set before it opens the card. ttl_ms is the hook's inner deadline,
 * so the card never outlives the wait (or the job token polling it).
 */
import type { PermissionContext, PermissionResolver } from "../../agent/manager";
import {
  autoAllowFromEnv,
  permissionPolicy,
  decisionFromPermRow,
} from "../../gateway/slack/permission-gate";
import type { NodeClient } from "../client";
import { decodeClaims } from "../remote";
import { pollPending } from "../pending";
import { wakeRefusal } from "../../proactive/wake-guard";

export interface NodePermissionDeps {
  client: NodeClient;
  tokenFor(sessionId: string): string | undefined;
  /** The session's current turn is a wake (worker.ts: the signed claim, else the job). */
  wakeFor?(sessionId: string): boolean;
}

/**
 * Whether a session's current turn is a wake: the signed `wake` claim of the
 * token bound for its job, or the job payload's `wake`. Either one is enough
 * (fail closed: a refusal is the safe side). Each job binds its own token and
 * resets the job flag, so a later normal job on the same session reads as not
 * a wake.
 */
export function isWakeTurn(boundToken: string | undefined, jobIsWake: boolean): boolean {
  const claims = boundToken ? decodeClaims(boundToken) : null;
  return claims?.wake === true || jobIsWake;
}

export function makeNodePermissionResolver(deps: NodePermissionDeps): PermissionResolver {
  const autoAllow = autoAllowFromEnv();
  return async (sessionId, toolName, input, ctx) => {
    if (deps.wakeFor?.(sessionId)) return { behavior: "deny", message: wakeRefusal(toolName) };
    const forced = (ctx as PermissionContext).ownerApproval;
    // An owner card skips only the local policy's allows, never its denies.
    const local = permissionPolicy(toolName, input, autoAllow);
    if (local && (!forced || local.behavior === "deny")) return local;

    const token = deps.tokenFor(sessionId);
    if (!token) return { behavior: "deny", message: "no job token for this session — cannot ask for permission" };

    let opened: { decision?: any; pendingId?: string };
    try {
      const res = await deps.client.postTool(
        "runtime",
        "can_use_tool",
        {
          tool_name: toolName,
          input,
          tool_use_id: ctx.toolUseID,
          ...(ctx.decisionReason ? { decision_reason: String(ctx.decisionReason) } : {}),
          ...(ctx.suggestions?.length ? { suggestions: ctx.suggestions } : {}),
          ...(forced ? { force_card: true, rule_id: forced.ruleId, ttl_ms: Math.max(1, Math.floor(forced.deadline - Date.now())) } : {}),
        },
        token,
      );
      if (res.isError) {
        return { behavior: "deny", message: `permission gate unavailable: ${res.content[0]?.text ?? "unknown error"}` };
      }
      opened = JSON.parse(res.content[0]?.text ?? "{}");
    } catch (e) {
      return { behavior: "deny", message: `permission gate unavailable: ${e instanceof Error ? e.message : String(e)}` };
    }

    // Gateway short-circuit (defense in depth — same policy, evaluated there).
    if (opened.decision) return opened.decision;
    if (!opened.pendingId) return { behavior: "deny", message: "permission gate returned no pendingId" };

    const outcome = await pollPending(deps.client, opened.pendingId, {
      signal: ctx.signal,
      jobToken: () => deps.tokenFor(sessionId) ?? token,
    });
    if (outcome === "aborted") return { behavior: "deny", message: "aborted" };
    if (outcome === "notfound") return { behavior: "deny", message: "permission gate disappeared before a decision" };
    if ("refused" in outcome) {
      return { behavior: "deny", message: `the gateway refused the permission poll (${outcome.refused.status})` };
    }
    return decisionFromPermRow(
      {
        status: outcome.status,
        resolvedBy: outcome.resolvedBy,
        payload: (outcome.payload ?? {}) as Record<string, unknown>,
      },
      toolName,
      input,
      ctx.suggestions,
    );
  };
}
