/**
 * Node-side permission resolver (spec §6): the SAME static policy the
 * gateway's PermissionGate applies runs locally first (no wire hop for the
 * always-allowed namespaces); anything needing a human goes through
 * POST /v1/tools/runtime/can_use_tool → {pendingId} → long-poll
 * /v1/pending/:id, honoring the click's allow-vs-always decision recorded in
 * the row payload. Fail closed: any wire failure is a deny, never a hang.
 */
import type { PermissionResolver } from "../../agent/manager";
import {
  autoAllowFromEnv,
  permissionPolicy,
  decisionFromPermRow,
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

    const outcome = await pollPending(deps.client, opened.pendingId, { signal: ctx.signal });
    if (outcome === "aborted") return { behavior: "deny", message: "aborted" };
    if (outcome === "notfound") return { behavior: "deny", message: "permission gate disappeared before a decision" };
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
