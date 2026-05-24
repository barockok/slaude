import { db } from "./schema";
import { randomUUID } from "node:crypto";

export type IgnoreRecord = {
  id: string;
  targetType: "user" | "thread";
  userId: string | null;
  channelId: string | null;
  threadTs: string | null;
  createdBy: string;
  createdAt: number;
  expiresAt: number | null;
  reason: string | null;
};

export function create(args: {
  targetType: "user" | "thread";
  userId?: string;
  channelId?: string;
  threadTs?: string;
  createdBy: string;
  expiresAt?: number;
  reason?: string;
}): IgnoreRecord {
  const id = randomUUID();
  const now = Date.now();
  db.run(
    `INSERT INTO ignores (id, target_type, user_id, channel_id, thread_ts, created_by, created_at, expires_at, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      args.targetType,
      args.userId ?? null,
      args.channelId ?? null,
      args.threadTs ?? null,
      args.createdBy,
      now,
      args.expiresAt ?? null,
      args.reason ?? null,
    ],
  );
  return findById(id)!;
}

export function findById(id: string): IgnoreRecord | null {
  const row = db.query("SELECT * FROM ignores WHERE id = ?").get(id) as any;
  return row ? mapRow(row) : null;
}

export function findActiveForUser(userId: string): IgnoreRecord | null {
  const now = Date.now();
  const row = db
    .query(
      `SELECT * FROM ignores
       WHERE target_type = 'user' AND user_id = ?
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY expires_at IS NULL DESC, created_at DESC
       LIMIT 1`,
    )
    .get(userId, now) as any;
  return row ? mapRow(row) : null;
}

export function findActiveForThread(channelId: string, threadTs: string): IgnoreRecord | null {
  const now = Date.now();
  const row = db
    .query(
      `SELECT * FROM ignores
       WHERE target_type = 'thread' AND channel_id = ? AND thread_ts = ?
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY expires_at IS NULL DESC, created_at DESC
       LIMIT 1`,
    )
    .get(channelId, threadTs, now) as any;
  return row ? mapRow(row) : null;
}

export function remove(args: { targetType: "user"; userId: string } | { targetType: "thread"; channelId: string; threadTs: string }): void {
  if (args.targetType === "user") {
    db.run("DELETE FROM ignores WHERE target_type = 'user' AND user_id = ?", [args.userId]);
  } else {
    db.run("DELETE FROM ignores WHERE target_type = 'thread' AND channel_id = ? AND thread_ts = ?", [
      args.channelId,
      args.threadTs,
    ]);
  }
}

export function cleanupExpired(): void {
  db.run("DELETE FROM ignores WHERE expires_at IS NOT NULL AND expires_at <= ?", [Date.now()]);
}

function mapRow(row: any): IgnoreRecord {
  return {
    id: row.id,
    targetType: row.target_type,
    userId: row.user_id,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    reason: row.reason,
  };
}
