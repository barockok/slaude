import { describe, it, expect } from "bun:test";
import { buildApprovalRequester, type GateLike } from "../../../src/gateway/slack/connect-wiring";

describe("connect approval bridge", () => {
  it("targets the owner and requests grant buttons, mapping scope through", async () => {
    const seen: any[] = [];
    const gate: GateLike = { request: async (req) => { seen.push(req); return { approved: true, by: "U1", scope: "thread" }; } };
    const requestApproval = buildApprovalRequester(gate);
    const out = await requestApproval({
      connection: { id: "c1", owner_slack_user_id: "U1" } as any,
      borrower: "U2", service: "jira", tool: "jira_search", argsHash: "abcdef0123", thread: { team_id: "T", channel_id: "C", thread_ts: "1.1" },
    });
    expect(seen[0].approvers).toEqual(["U1"]);
    expect(seen[0].grantButtons).toBe(true);
    expect(seen[0].channel).toBe("C");
    expect(seen[0].threadTs).toBe("1.1");
    expect(seen[0].summary).toContain("jira_search");
    expect(out).toEqual({ approved: true, by: "U1", scope: "thread" });
  });
});
