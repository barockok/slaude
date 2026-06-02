import { describe, it, expect } from "bun:test";
import { resolveConnection, type ResolverDeps } from "../../../src/agent/connect-broker/resolver";
import type { ConnectionRow } from "../../../src/db/schema";

const T = { team_id: "T", channel_id: "C", thread_ts: "1.1" };
const conn = (owner: string): ConnectionRow => ({
  id: `c-${owner}`, owner_slack_user_id: owner, service: "jira", scope: "thread",
  team_id: "T", channel_id: "C", thread_ts: "1.1", auth_strategy: "token",
  cred_ciphertext: "x", key_id: "k", created_at: 0, last_used_at: null, expires_at: null, status: "active",
});

function deps(over: Partial<ResolverDeps> = {}): ResolverDeps {
  return {
    findOwn: () => null,
    findBorrowCandidate: () => null,
    findSlaude: () => null,
    findActiveGrant: () => null,
    ...over,
  };
}

describe("resolveConnection", () => {
  it("uses the caller's own connection when present", () => {
    const r = resolveConnection({ caller: "U1", service: "jira", tool: "jira_search", thread: T }, deps({ findOwn: () => conn("U1") }));
    expect(r.kind).toBe("own");
  });

  it("personal tool with no own connection => needs_connect (no slaude fallback)", () => {
    const r = resolveConnection({ caller: "U1", service: "jira", tool: "jira_list_my_issues", thread: T }, deps({ findSlaude: () => conn("slaude") }));
    expect(r.kind).toBe("needs_connect");
  });

  it("borrowable tool, candidate exists, active grant => borrow_granted", () => {
    const r = resolveConnection(
      { caller: "U2", service: "jira", tool: "jira_search", thread: T },
      deps({ findBorrowCandidate: () => conn("U1"), findActiveGrant: () => ({ id: "g" } as any) }),
    );
    expect(r.kind).toBe("borrow_granted");
  });

  it("borrowable tool, candidate exists, no grant => needs_approval", () => {
    const r = resolveConnection(
      { caller: "U2", service: "jira", tool: "jira_search", thread: T },
      deps({ findBorrowCandidate: () => conn("U1") }),
    );
    expect(r.kind).toBe("needs_approval");
    if (r.kind === "needs_approval") expect(r.connection.owner_slack_user_id).toBe("U1");
  });

  it("owner-only tool can never be borrowed => denied", () => {
    const r = resolveConnection(
      { caller: "U2", service: "jira", tool: "jira_delete_issue", thread: T },
      deps({ findBorrowCandidate: () => conn("U1") }),
    );
    expect(r.kind).toBe("denied");
  });

  it("unclassified tool fails closed (personal) and does NOT fall back to slaude", () => {
    const r = resolveConnection({ caller: "U1", service: "jira", tool: "unknown_tool", thread: T }, deps({ findSlaude: () => conn("slaude") }));
    expect(r.kind).toBe("needs_connect");
  });

  it("shared-ok tool with no own connection falls back to slaude's connection", () => {
    const r = resolveConnection({ caller: "U1", service: "jira", tool: "jira_list_projects", thread: T }, deps({ findSlaude: () => conn("slaude") }));
    expect(r.kind).toBe("slaude");
    if (r.kind === "slaude") expect(r.connection.owner_slack_user_id).toBe("slaude");
  });

  it("shared-ok tool with no own connection and no slaude conn => needs_connect", () => {
    const r = resolveConnection({ caller: "U1", service: "jira", tool: "jira_list_projects", thread: T }, deps());
    expect(r.kind).toBe("needs_connect");
  });
});
