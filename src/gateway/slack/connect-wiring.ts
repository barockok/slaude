import type { ThreadKey } from "../../db/connections";
import type { ConnectionRow } from "../../db/schema";
import type { ApprovalOutcome } from "../../agent/connect-broker/broker-core";

export type GateLike = {
  request: (req: {
    channel: string; threadTs: string; summary: string; approvers?: string[]; grantButtons?: boolean;
  }) => Promise<{ approved: boolean; by: string; scope?: "thread" | "once" }>;
};

/**
 * Build the broker's requestApproval using the (extended) ApprovalGate.
 * The approval is posted into the borrowing thread (derived from args.thread),
 * targeted at the connection owner, with the 3-button grant variant.
 */
export function buildApprovalRequester(gate: GateLike) {
  return async (args: {
    connection: ConnectionRow; borrower: string; service: string; tool: string; argsHash: string; thread: ThreadKey;
  }): Promise<ApprovalOutcome> => {
    const d = await gate.request({
      channel: args.thread.channel_id,
      threadTs: args.thread.thread_ts,
      summary: `<@${args.borrower}> wants to use <@${args.connection.owner_slack_user_id}>'s *${args.service}* — tool \`${args.tool}\` (call ${args.argsHash.slice(0, 8)}). Allow for this thread?`,
      approvers: [args.connection.owner_slack_user_id],
      grantButtons: true,
    });
    return { approved: d.approved, by: d.by, scope: d.scope };
  };
}
