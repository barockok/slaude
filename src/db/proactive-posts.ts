import { randomUUID } from "node:crypto";
import { db } from "./schema";

/**
 * The proactive post ledger (spec §10.4, §10.5; migration 0029): what the
 * restraint rules count and what feedback finds a post by. Database only.
 */
export type Audience = "manager" | "person" | "channel";

export interface ProactivePost {
  id: string;
  agentId: string;
  audience: Audience;
  /** A user id (manager, person) or a channel id. */
  recipient: string;
  topic: string;
  textHash: string;
  /** Where it was posted: the DM channel or the channel. */
  channelId: string;
  messageTs: string | null;
  teamId: string | null;
  postedAt: number;
}

interface Row {
  id: string;
  agent_id: string;
  audience: string;
  recipient: string;
  topic: string;
  text_hash: string;
  channel_id: string;
  message_ts: string | null;
  team_id: string | null;
  posted_at: number | string;
}

const toPost = (r: Row): ProactivePost => ({
  id: r.id,
  agentId: r.agent_id,
  audience: r.audience as Audience,
  recipient: r.recipient,
  topic: r.topic,
  textHash: r.text_hash,
  channelId: r.channel_id,
  messageTs: r.message_ts,
  teamId: r.team_id,
  postedAt: Number(r.posted_at),
});

export async function recordPost(p: Omit<ProactivePost, "id">): Promise<string> {
  const id = randomUUID();
  await db.run(
    `INSERT INTO proactive_posts (id, agent_id, audience, recipient, topic, text_hash, channel_id, message_ts, team_id, posted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, p.agentId, p.audience, p.recipient, p.topic, p.textHash, p.channelId, p.messageTs, p.teamId, p.postedAt],
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

/** The proactive post a Slack message is, by its channel and ts. */
export async function findByMessage(channelId: string, messageTs: string): Promise<ProactivePost | null> {
  const row = await db.one<Row>(`SELECT * FROM proactive_posts WHERE channel_id = ? AND message_ts = ? LIMIT 1`, [channelId, messageTs]);
  return row ? toPost(row) : null;
}
