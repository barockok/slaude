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

export async function create(args: {
  targetType: "user" | "thread";
  userId?: string;
  channelId?: string;
  threadTs?: string;
  createdBy: string;
  expiresAt?: number;
  reason?: string;
}): Promise<IgnoreRecord> {
  const id = randomUUID();
  const now = Date.now();
  await db.run(
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
  return (await findById(id))!;
}

export async function findById(id: string): Promise<IgnoreRecord | null> {
  const row = await db.one<any>("SELECT * FROM ignores WHERE id = ?", [id]);
  return row ? mapRow(row) : null;
}

export async function findActiveForUser(userId: string): Promise<IgnoreRecord | null> {
  const now = Date.now();
  const row = await db.one<any>(
    `SELECT * FROM ignores
     WHERE target_type = 'user' AND user_id = ?
       AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY expires_at IS NULL DESC, created_at DESC
     LIMIT 1`,
    [userId, now],
  );
  return row ? mapRow(row) : null;
}

export async function findActiveForThread(channelId: string, threadTs: string): Promise<IgnoreRecord | null> {
  const now = Date.now();
  const row = await db.one<any>(
    `SELECT * FROM ignores
     WHERE target_type = 'thread' AND channel_id = ? AND thread_ts = ?
       AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY expires_at IS NULL DESC, created_at DESC
     LIMIT 1`,
    [channelId, threadTs, now],
  );
  return row ? mapRow(row) : null;
}

export async function remove(
  args: { targetType: "user"; userId: string } | { targetType: "thread"; channelId: string; threadTs: string },
): Promise<number> {
  if (args.targetType === "user") {
    return (await db.run("DELETE FROM ignores WHERE target_type = 'user' AND user_id = ?", [args.userId])).changes;
  } else {
    return (
      await db.run("DELETE FROM ignores WHERE target_type = 'thread' AND channel_id = ? AND thread_ts = ?", [
        args.channelId,
        args.threadTs,
      ])
    ).changes;
  }
}

export async function cleanupExpired(): Promise<void> {
  await db.run("DELETE FROM ignores WHERE expires_at IS NOT NULL AND expires_at <= ?", [Date.now()]);
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
