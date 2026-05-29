import { describe, it, expect } from "bun:test";
import { runCall, type BrokerCoreDeps } from "../../../src/agent/connect-broker/broker-core";
import type { ConnectionRow } from "../../../src/db/schema";

const T = { team_id: "T", channel_id: "C", thread_ts: "1.1" };
const conn = (owner: string): ConnectionRow => ({
  id: `c-${owner}`, owner_slack_user_id: owner, service: "jira", scope: "thread",
  team_id: "T", channel_id: "C", thread_ts: "1.1", auth_strategy: "token",
  cred_ciphertext: "CT", key_id: "k", created_at: 0, last_used_at: null, expires_at: null, status: "active",
});

function deps(over: Partial<BrokerCoreDeps> = {}): BrokerCoreDeps & { _audit: any[] } {
  const audit: any[] = [];
  return {
    resolve: () => ({ kind: "own", connection: conn("U1") }),
    decrypt: () => "PLAINTEXT",
    acquireChild: async () => ({ callTool: async (t, a) => ({ echoed: { t, a } }), deliverCred() {}, kill() {} }),
    releaseChild: () => {},
    requestApproval: async () => ({ approved: true, by: "U1", scope: "thread" }),
    insertGrant: () => {},
    appendAudit: (a) => audit.push(a),
    touchLastUsed: () => {},
    isMember: () => true,
    now: () => 123,
    _audit: audit,
    ...over,
  } as any;
}

describe("runCall", () => {
  it("own connection: forwards to child and audits 'used'", async () => {
    const d = deps();
    const r = await runCall({ caller: "U1", service: "jira", tool: "jira_search", args: { jql: "x" }, thread: T }, d);
    expect(r.kind).toBe("ok");
    expect(d._audit.at(-1).decision).toBe("used");
  });

  it("needs_connect: returns a needs_connect outcome, no child call", async () => {
    const r = await runCall({ caller: "U1", service: "jira", tool: "jira_list_my_issues", args: {}, thread: T },
      deps({ resolve: () => ({ kind: "needs_connect" }) }));
    expect(r.kind).toBe("needs_connect");
  });

  it("denied (owner-only borrow): returns denied", async () => {
    const r = await runCall({ caller: "U2", service: "jira", tool: "jira_delete_issue", args: {}, thread: T },
      deps({ resolve: () => ({ kind: "denied", reason: "owner-only" }) }));
    expect(r.kind).toBe("denied");
  });

  it("needs_approval + owner approves 'thread': writes a grant then forwards", async () => {
    let granted = false;
    const r = await runCall({ caller: "U2", service: "jira", tool: "jira_search", args: { jql: "y" }, thread: T },
      deps({
        resolve: () => ({ kind: "needs_approval", connection: conn("U1") }),
        insertGrant: () => { granted = true; },
        requestApproval: async () => ({ approved: true, by: "U1", scope: "thread" }),
      }));
    expect(r.kind).toBe("ok");
    expect(granted).toBe(true);
  });

  it("needs_approval + deny: returns denied, no grant, audits denied", async () => {
    const d = deps({
      resolve: () => ({ kind: "needs_approval", connection: conn("U1") }),
      requestApproval: async () => ({ approved: false, by: "U1" }),
    });
    const r = await runCall({ caller: "U2", service: "jira", tool: "jira_search", args: {}, thread: T }, d);
    expect(r.kind).toBe("denied");
    expect(d._audit.at(-1).decision).toBe("denied");
  });

  it("non-member caller is rejected before any resolution", async () => {
    let resolved = false;
    const r = await runCall({ caller: "U9", service: "jira", tool: "jira_search", args: {}, thread: T },
      deps({ isMember: () => false, resolve: () => { resolved = true; return { kind: "needs_connect" }; } }));
    expect(r.kind).toBe("denied");
    expect(resolved).toBe(false);
  });

  it("just-once approval forwards but writes NO grant", async () => {
    let granted = false;
    const r = await runCall({ caller: "U2", service: "jira", tool: "jira_search", args: {}, thread: T },
      deps({
        resolve: () => ({ kind: "needs_approval", connection: conn("U1") }),
        insertGrant: () => { granted = true; },
        requestApproval: async () => ({ approved: true, by: "U1", scope: "once" }),
      }));
    expect(r.kind).toBe("ok");
    expect(granted).toBe(false);
  });
});
