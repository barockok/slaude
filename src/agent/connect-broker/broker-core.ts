import type { ConnectionRow } from "../../db/schema";
import type { ThreadKey } from "../../db/connections";
import type { ResolveResult } from "./resolver";
import type { ChildHandle } from "./child-pool";
import { canonicalArgsHash } from "./arg-hash";

export type ApprovalOutcome = { approved: boolean; by: string; scope?: "thread" | "once" };

export type AuditEntry = {
  connection_id: string; borrower_slack_user_id: string; approver_id?: string | null;
  service?: string; tool?: string; args_hash?: string; decision: string; now: number;
};

export type BrokerCoreDeps = {
  resolve: (input: { caller: string; service: string; tool: string; thread: ThreadKey }) => ResolveResult;
  decrypt: (conn: ConnectionRow) => string;
  acquireChild: (connectionId: string, credPlaintext: string) => Promise<ChildHandle>;
  releaseChild: (connectionId: string) => void;
  requestApproval: (args: {
    connection: ConnectionRow; borrower: string; service: string; tool: string; argsHash: string; thread: ThreadKey;
  }) => Promise<ApprovalOutcome>;
  insertGrant: (args: { connection_id: string; borrower_slack_user_id: string; thread: ThreadKey; now: number }) => void;
  appendAudit: (e: AuditEntry) => void;
  touchLastUsed: (connectionId: string, now: number) => void;
  isMember: (caller: string, thread: ThreadKey) => boolean;
  now: () => number;
};

export type CallInput = { caller: string; service: string; tool: string; args: unknown; thread: ThreadKey };

export type CallOutcome =
  | { kind: "ok"; result: unknown }
  | { kind: "needs_connect" }
  | { kind: "denied"; reason: string };

export async function runCall(input: CallInput, deps: BrokerCoreDeps): Promise<CallOutcome> {
  // H5: verify thread membership before anything else.
  if (!deps.isMember(input.caller, input.thread)) {
    return { kind: "denied", reason: "You are not a member of this thread." };
  }

  const r = deps.resolve({ caller: input.caller, service: input.service, tool: input.tool, thread: input.thread });

  if (r.kind === "needs_connect") return { kind: "needs_connect" };
  if (r.kind === "denied") return { kind: "denied", reason: r.reason };

  const argsHash = canonicalArgsHash(input.service, input.tool, input.args);

  // Borrow path needing approval.
  if (r.kind === "needs_approval") {
    const outcome = await deps.requestApproval({
      connection: r.connection, borrower: input.caller, service: input.service, tool: input.tool, argsHash, thread: input.thread,
    });
    if (!outcome.approved) {
      deps.appendAudit({ connection_id: r.connection.id, borrower_slack_user_id: input.caller, approver_id: outcome.by, service: input.service, tool: input.tool, args_hash: argsHash, decision: "denied", now: deps.now() });
      return { kind: "denied", reason: `@${r.connection.owner_slack_user_id} did not approve.` };
    }
    if (outcome.scope === "thread") {
      deps.insertGrant({ connection_id: r.connection.id, borrower_slack_user_id: input.caller, thread: input.thread, now: deps.now() });
    }
    return forward(input, r.connection, argsHash, "approved", outcome.by, deps);
  }

  // own / borrow_granted / slaude: forward directly.
  const conn = r.connection;
  // Kept explicit (both "used") to leave an obvious seam if own vs borrow auditing later diverges.
  const decision = r.kind === "own" || r.kind === "slaude" ? "used" : "used";
  return forward(input, conn, argsHash, decision, null, deps);
}

async function forward(
  input: CallInput, conn: ConnectionRow, argsHash: string, decision: string, approver: string | null, deps: BrokerCoreDeps,
): Promise<CallOutcome> {
  const cred = deps.decrypt(conn);
  const child = await deps.acquireChild(conn.id, cred);
  try {
    const result = await child.callTool(input.tool, input.args);
    deps.touchLastUsed(conn.id, deps.now());
    deps.appendAudit({ connection_id: conn.id, borrower_slack_user_id: input.caller, approver_id: approver, service: input.service, tool: input.tool, args_hash: argsHash, decision, now: deps.now() });
    return { kind: "ok", result };
  } finally {
    deps.releaseChild(conn.id);
  }
}
