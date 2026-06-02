import { describe, it, expect } from "bun:test";
import { db } from "../../src/db/schema";
import { randomUUID } from "node:crypto";

describe("connections schema", () => {
  it("creates the connections table with expected columns", () => {
    const cols = db.query(`PRAGMA table_info(connections)`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    for (const c of [
      "id","owner_slack_user_id","service","scope","team_id","channel_id",
      "thread_ts","auth_strategy","cred_ciphertext","key_id","created_at",
      "last_used_at","expires_at","status",
    ]) expect(names).toContain(c);
  });

  it("creates connection_grants and connection_audit tables", () => {
    const grants = db.query(`PRAGMA table_info(connection_grants)`).all() as any[];
    const audit = db.query(`PRAGMA table_info(connection_audit)`).all() as any[];
    expect(grants.length).toBeGreaterThan(0);
    expect(audit.length).toBeGreaterThan(0);
  });

  it("enforces slaude-scope uniqueness on (owner, service) with distinct ids", () => {
    db.run(`DELETE FROM connections WHERE service = 'unittest'`);
    const insertSlaude = () =>
      db.run(
        `INSERT INTO connections (id, owner_slack_user_id, service, scope, team_id, channel_id, thread_ts, auth_strategy, cred_ciphertext, key_id, created_at, status)
         VALUES (?, 'U1', 'unittest', 'slaude', NULL, NULL, NULL, 'token', 'x', 'k1', 0, 'active')`,
        [randomUUID()],
      );
    insertSlaude(); // first ok
    expect(() => insertSlaude()).toThrow(); // second collides on idx_conn_slaude despite distinct PK
    db.run(`DELETE FROM connections WHERE service = 'unittest'`);
  });

  it("allows two thread-scope connections for the same (owner, service) in different threads", () => {
    db.run(`DELETE FROM connections WHERE service = 'unittest'`);
    const insertThread = (thread: string) =>
      db.run(
        `INSERT INTO connections (id, owner_slack_user_id, service, scope, team_id, channel_id, thread_ts, auth_strategy, cred_ciphertext, key_id, created_at, status)
         VALUES (?, 'U1', 'unittest', 'thread', 'T', 'C', ?, 'token', 'x', 'k1', 0, 'active')`,
        [randomUUID(), thread],
      );
    insertThread("100.1");
    expect(() => insertThread("200.2")).not.toThrow(); // distinct thread_ts => allowed
    expect(() => insertThread("100.1")).toThrow(); // same thread tuple => collides
    db.run(`DELETE FROM connections WHERE service = 'unittest'`);
  });
});
