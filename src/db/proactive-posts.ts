import { randomUUID } from "node:crypto";
import type { Level } from "../proactive/levels";
import { db } from "./schema";

/**
 * The proactive post ledger (spec §10.4, §10.5; migration 0029): what the
 * restraint rules count and what feedback finds a post by. Database only.
 */
export type Audience = "manager" | "person" | "channel";

/** What a post rested on (migration 0030), stored as JSON. */
export interface PostContext {
  source: string | null;
  itemId: string | null;
  summary: string;
  ruleSlug: string | null;
  level: Level;
  evidence: string;
}

export interface ProactivePost {
  id: string;
  agentId: string;
  audience: Audience;
  /** A user id (manager, person) or a channel id. */
  recipient: string;
  topic: string;
  textHash: string;
  /** Hash of the evidence the post rests on, or null for an older row. */
  evidenceHash: string | null;
  /** Where it was posted: the DM channel or the channel. */
  channelId: string;
  messageTs: string | null;
  teamId: string | null;
  postedAt: number;
  /** The text that was sent, or null for a row written before migration 0030. */
  text: string | null;
  /** What the post rested on, or null for an older row or unreadable JSON. */
  context: PostContext | null;
  /** The Slack app (api_app_id) that posted it, or null when unknown (an older row, a single-app transport). */
  appId: string | null;
}

interface Row {
  id: string;
  agent_id: string;
  audience: string;
  recipient: string;
  topic: string;
  text_hash: string;
  evidence_hash: string | null;
  channel_id: string;
  message_ts: string | null;
  team_id: string | null;
  posted_at: number | string;
  text: string | null;
  context: string | null;
  app_id: string | null;
}

function parseContext(raw: string | null): PostContext | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as PostContext) : null;
  } catch {
    return null;
  }
}

const toPost = (r: Row): ProactivePost => ({
  id: r.id,
  agentId: r.agent_id,
  audience: r.audience as Audience,
  recipient: r.recipient,
  topic: r.topic,
  textHash: r.text_hash,
  evidenceHash: r.evidence_hash ?? null,
  channelId: r.channel_id,
  messageTs: r.message_ts,
  teamId: r.team_id,
  postedAt: Number(r.posted_at),
  text: r.text ?? null,
  context: parseContext(r.context ?? null),
  appId: r.app_id ?? null,
});

/** Record a post; `id` when the caller minted it before posting (the Slack metadata marker carries it). */
export async function recordPost(
  p: Omit<ProactivePost, "id" | "text" | "context" | "appId"> & { id?: string; text?: string | null; context?: PostContext | null; appId?: string | null },
): Promise<string> {
  const id = p.id ?? randomUUID();
  await db.run(
    `INSERT INTO proactive_posts (id, agent_id, audience, recipient, topic, text_hash, evidence_hash, channel_id, message_ts, team_id, posted_at, text, context, app_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, p.agentId, p.audience, p.recipient, p.topic, p.textHash, p.evidenceHash, p.channelId, p.messageTs, p.teamId, p.postedAt, p.text ?? null, p.context ? JSON.stringify(p.context) : null, p.appId ?? null],
  );
  return id;
}

/** An agent's posts to one recipient since `sinceMs`, newest first. */
export async function recentFor(agentId: string, recipient: string, sinceMs: number): Promise<ProactivePost[]> {
  const rows = await db.query<Row>(
    `SELECT * FROM proactive_posts WHERE agent_id = ? AND recipient = ? AND posted_at >= ? ORDER BY posted_at DESC`,
    [agentId, recipient, sinceMs],
  );
  return rows.map(toPost);
}

/** An agent's posts to anyone since `sinceMs`, newest first, at most `limit`. */
export async function recentByAgent(agentId: string, sinceMs: number, limit: number): Promise<ProactivePost[]> {
  const rows = await db.query<Row>(
    `SELECT * FROM proactive_posts WHERE agent_id = ? AND posted_at >= ? ORDER BY posted_at DESC LIMIT ?`,
    [agentId, sinceMs, limit],
  );
  return rows.map(toPost);
}

/**
 * Whether the agent posted about this source item since `sinceMs`, to anyone:
 * the heartbeat round's item dedupe (an item goes out once, to one place).
 * The context is JSON, so rows are matched here, not in SQL.
 */
export async function postedItem(agentId: string, source: string, itemId: string, sinceMs: number): Promise<boolean> {
  const rows = await db.query<Pick<Row, "context">>(
    `SELECT context FROM proactive_posts WHERE agent_id = ? AND posted_at >= ? AND context IS NOT NULL`,
    [agentId, sinceMs],
  );
  return rows.some((r) => {
    const c = parseContext(r.context);
    return c?.source === source && c.itemId === itemId;
  });
}

/** The proactive post a Slack message is, by its channel and ts. */
export async function findByMessage(channelId: string, messageTs: string): Promise<ProactivePost | null> {
  const row = await db.one<Row>(`SELECT * FROM proactive_posts WHERE channel_id = ? AND message_ts = ? LIMIT 1`, [channelId, messageTs]);
  return row ? toPost(row) : null;
}
