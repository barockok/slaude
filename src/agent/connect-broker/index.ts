import * as Conn from "../../db/connections";
import type { ThreadKey } from "../../db/connections";
import type { ConnectionRow } from "../../db/schema";
import { decryptCred } from "./crypto";
import { ChildPool, type ChildHandle } from "./child-pool";
import { resolveConnection } from "./resolver";
import { runCall as coreRunCall, type ApprovalOutcome, type BrokerCoreDeps } from "./broker-core";
import type { BrokerToolCtx } from "./broker-mcp";

export type BrokerConfig = {
  key: Buffer;
  idleMs: number;
  spawnChild: (connectionId: string) => ChildHandle;
  requestApproval: (args: {
    connection: ConnectionRow; borrower: string; service: string; tool: string; argsHash: string; thread: ThreadKey;
  }) => Promise<ApprovalOutcome>;
  isMember: (caller: string, thread: ThreadKey) => boolean;
};

export type BuildCtxArgs = {
  /**
   * Reads the CURRENT turn's slack user id at call time. MUST be live, not a
   * snapshot — the per-session MCP resolver runs once at session boot, but a
   * thread session serves many users across turns. Snapshotting here would
   * freeze authorization to the booting user (cross-user identity confusion).
   */
  getCallerUserId: () => string;
  thread: ThreadKey;
  /** Starts the connect/login flow for a service; returns the live-view URL + TTL. */
  postConnectUrl: (service: string) => Promise<{ url: string; expiresInMs: number }>;
};

export function createBroker(cfg: BrokerConfig) {
  const pool = new ChildPool({ spawnChild: cfg.spawnChild, idleMs: cfg.idleMs });

  // Periodic reaper. Caller may also drive reapIdle in tests.
  const reaper = setInterval(() => pool.reapIdle(), Math.max(30_000, cfg.idleMs));
  (reaper as any).unref?.();

  function buildCtx(args: BuildCtxArgs): BrokerToolCtx {
    const thread = args.thread;
    const deps: BrokerCoreDeps = {
      resolve: (i) =>
        resolveConnection(i, {
          findOwn: Conn.findOwnConnection,
          findBorrowCandidate: Conn.findBorrowCandidate,
          findSlaude: Conn.findSlaudeConnection,
          findActiveGrant: Conn.findActiveGrant,
        }),
      decrypt: (conn) => decryptCred(cfg.key, conn.id, conn.cred_ciphertext),
      acquireChild: (id, cred) => pool.acquire(id, cred),
      releaseChild: (id) => pool.release(id),
      requestApproval: cfg.requestApproval,
      insertGrant: (g) => { Conn.insertGrant(g); },
      appendAudit: (e) => Conn.appendAudit(e),
      touchLastUsed: (id, now) => Conn.touchLastUsed(id, now),
      isMember: cfg.isMember,
      now: () => Date.now(),
    };
    return {
      // Live getter — re-read on every access so the acting user reflects the
      // current turn, never the user who happened to boot the session.
      get callerUserId() { return args.getCallerUserId(); },
      runCall: (input) => coreRunCall({ ...input, thread }, deps),
      listConnections: () => {
        const caller = args.getCallerUserId();
        const rows = Conn.listForThread(thread);
        return rows.map((r) => ({
          service: r.service,
          owner: r.owner_slack_user_id,
          mine: r.owner_slack_user_id === caller,
          expiresInMs: r.expires_at == null ? null : r.expires_at - Date.now(),
        }));
      },
      startConnect: async (service: string) => args.postConnectUrl(service),
      revoke: (service?: string) => {
        const caller = args.getCallerUserId();
        const rows = Conn.listForThread(thread).filter(
          (r) => r.owner_slack_user_id === caller && (!service || r.service === service),
        );
        for (const r of rows) {
          Conn.setStatus(r.id, "revoked");
          Conn.revokeGrantsForConnection(r.id, Date.now());
          pool.evict(r.id);
        }
        return { revoked: rows.length };
      },
      describe: async (service: string) => ({
        service,
        note: "describe is served from the registry/cached child schema at deploy time",
      }),
    };
  }

  function reapExpiredConnections(now: number = Date.now()) {
    for (const row of Conn.listExpired(now)) {
      Conn.setStatus(row.id, "expired");
      pool.evict(row.id);
    }
  }

  return { buildCtx, pool, reapExpiredConnections, stop: () => clearInterval(reaper) };
}
