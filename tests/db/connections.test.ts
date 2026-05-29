import { describe, it, expect, beforeEach } from "bun:test";
import * as Conn from "../../src/db/connections";

const THREAD = { team_id: "T", channel_id: "C", thread_ts: "100.1" };

beforeEach(() => {
  Conn._wipeForTests();
});

describe("connections accessors", () => {
  it("inserts and finds an owner's thread connection", () => {
    const row = Conn.insertConnection({
      owner_slack_user_id: "U1", service: "jira", scope: "thread",
      thread: THREAD, auth_strategy: "token", cred_ciphertext: "ct", key_id: "k1",
      now: 1000, expires_at: 9999,
    });
    const found = Conn.findOwnConnection("U1", "jira", THREAD);
    expect(found?.id).toBe(row.id);
  });

  it("findBorrowCandidate returns another member's connection, not the caller's", () => {
    Conn.insertConnection({ owner_slack_user_id: "U1", service: "jira", scope: "thread", thread: THREAD, auth_strategy: "token", cred_ciphertext: "ct", key_id: "k1", now: 1000 });
    const cand = Conn.findBorrowCandidate("U2", "jira", THREAD);
    expect(cand?.owner_slack_user_id).toBe("U1");
    expect(Conn.findBorrowCandidate("U1", "jira", THREAD)).toBeNull(); // own conn isn't a borrow candidate
  });

  it("grants: insert, find active, revoke", () => {
    const conn = Conn.insertConnection({ owner_slack_user_id: "U1", service: "jira", scope: "thread", thread: THREAD, auth_strategy: "token", cred_ciphertext: "ct", key_id: "k1", now: 1000 });
    Conn.insertGrant({ connection_id: conn.id, borrower_slack_user_id: "U2", thread: THREAD, now: 1000 });
    expect(Conn.findActiveGrant(conn.id, "U2")).not.toBeNull();
    Conn.revokeGrantsForConnection(conn.id, 2000);
    expect(Conn.findActiveGrant(conn.id, "U2")).toBeNull();
  });

  it("listExpired returns rows past their TTL", () => {
    Conn.insertConnection({ owner_slack_user_id: "U1", service: "jira", scope: "thread", thread: THREAD, auth_strategy: "token", cred_ciphertext: "ct", key_id: "k1", now: 1000, expires_at: 1500 });
    expect(Conn.listExpired(2000).length).toBe(1);
    expect(Conn.listExpired(1200).length).toBe(0);
  });

  it("audit append + query by connection", () => {
    const conn = Conn.insertConnection({ owner_slack_user_id: "U1", service: "jira", scope: "thread", thread: THREAD, auth_strategy: "token", cred_ciphertext: "ct", key_id: "k1", now: 1000 });
    Conn.appendAudit({ connection_id: conn.id, borrower_slack_user_id: "U2", approver_id: "U1", service: "jira", tool: "jira_search", args_hash: "h", decision: "used", now: 1100 });
    expect(Conn.auditForConnection(conn.id).length).toBe(1);
  });
});
