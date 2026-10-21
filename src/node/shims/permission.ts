/**
 * Node-side permission resolver (spec §6): the SAME static policy the
 * gateway's PermissionGate applies runs locally first (no wire hop for the
 * always-allowed namespaces); anything needing a human goes through
 * POST /v1/tools/runtime/can_use_tool → {pendingId} → long-poll
 * /v1/pending/:id, honoring the click's allow-vs-always decision recorded in
 * the row payload. Fail closed: any wire failure is a deny, never a hang.
 */
import type { OwnerGuard, OwnerGuardDecision, PermissionResolver } from "../../agent/manager";
import {
  autoAllowFromEnv,
  permissionPolicy,
  decisionFromPermRow,
  ownerDecision,
} from "../../gateway/slack/permission-gate";
import type { NodeClient } from "../client";
import { pollPending } from "../pending";

export interface NodePermissionDeps {
  client: NodeClient;
  tokenFor(sessionId: string): string | undefined;
}

export function makeNodePermissionResolver(deps: NodePermissionDeps): PermissionResolver {
  const autoAllow = autoAllowFromEnv();
  return async (sessionId, toolName, input, ctx) => {
    const local = permissionPolicy(toolName, input, autoAllow);
    if (local) return local;

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

/**
 * Node-side /1on1 owner guard (agent/guests.ts): an owner-only call in a
 * guest's turn opens an owner card on the gateway through
 * POST /v1/tools/runtime/owner_gate and long-polls /v1/pending/:id. The
 * gateway reads the owner from its own lock row and counts only the owner's
 * click, so nothing the node sends can choose who approves. Fail closed: any
 * wire failure is a deny.
 */
export function makeNodeOwnerGuard(deps: NodePermissionDeps): OwnerGuard {
  return async (req): Promise<OwnerGuardDecision> => {
    const deny = (why: string): OwnerGuardDecision => ({
      allow: false,
      reason: `OWNER_ONLY: \`${req.toolName}\` needs the 1on1 owner's approval in a guest's turn and was not run (${why}).`,
    });
    const token = deps.tokenFor(req.sessionId);
    if (!token) return deny("no job token for this session");

    let opened: { decision?: any; pendingId?: string; owner?: string };
    try {
      const res = await deps.client.postTool(
        "runtime",
        "owner_gate",
        { tool_name: req.toolName, input: req.input, tool_use_id: req.toolUseId, rule: req.rule },
        token,
      );
      if (res.isError) return deny(`owner gate unavailable: ${res.content[0]?.text ?? "unknown error"}`);
      opened = JSON.parse(res.content[0]?.text ?? "{}");
    } catch (e) {
      return deny(`owner gate unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (opened.decision) return ownerDecision(opened.decision, req.toolName, opened.owner);
    if (!opened.pendingId) return deny("the owner gate returned no pendingId");

    const outcome = await pollPending(deps.client, opened.pendingId, {
      signal: req.signal,
      jobToken: () => deps.tokenFor(req.sessionId) ?? token,
    });
    if (outcome === "aborted") return deny("aborted");
    if (outcome === "notfound") return deny("the owner gate disappeared before a decision");
    if ("refused" in outcome) return deny(`the gateway refused the owner-gate poll (${outcome.refused.status})`);
    const d = decisionFromPermRow(
      { status: outcome.status, resolvedBy: outcome.resolvedBy, payload: (outcome.payload ?? {}) as Record<string, unknown> },
      req.toolName,
      req.input,
      undefined,
    );
    return ownerDecision(d, req.toolName, opened.owner);
  };
}
