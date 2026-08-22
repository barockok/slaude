import { randomUUID } from "node:crypto";
import { db } from "./schema";

export interface DecisionItem {
  decision: string;
  rationale?: string;
  owner?: string;
  followUp?: string;
  evidenceRefs: string[];
}

export interface DecisionNote {
  id: string;
  tag: string;
  title: string;
  summary: string;
  decisions: DecisionItem[];
  instruction: string | null;
  slackTeamId: string;
  slackChannelId: string;
  slackThreadTs: string;
  sourceMessageTs: string;
  sourcePermalink: string;
  sourceMessageCount: number;
  sourceTruncated: boolean;
  createdBy: string;
  createdAt: number;
  personaId: string;
  summarizerModel: string;
}

interface DecisionNoteRow {
  id: string;
  tag: string;
  title: string;
  summary: string;
  decisions_json: string;
  instruction: string | null;
  slack_team_id: string;
  slack_channel_id: string;
  slack_thread_ts: string;
  source_message_ts: string;
  source_permalink: string;
  source_message_count: number;
  source_truncated: number;
  created_by: string;
  created_at: number;
  persona_id: string;
  summarizer_model: string;
}

export interface DecisionNoteScope {
  slackTeamId: string;
  personaId: string;
}

export interface DecisionTagSummary {
  tag: string;
  count: number;
  latest: DecisionNote;
}

export interface CreateDecisionNote extends DecisionNoteScope {
  tag: string;
  title: string;
  summary: string;
  decisions: DecisionItem[];
  instruction?: string;
  slackChannelId: string;
  slackThreadTs: string;
  sourceMessageTs: string;
  sourcePermalink: string;
  sourceMessageCount: number;
  sourceTruncated: boolean;
  createdBy: string;
  summarizerModel: string;
}

function fromRow(row: DecisionNoteRow): DecisionNote {
  let decisions: DecisionItem[] = [];
  try {
    const value = JSON.parse(row.decisions_json);
    if (Array.isArray(value)) decisions = value as DecisionItem[];
  } catch {}
  return {
    id: row.id,
    tag: row.tag,
    title: row.title,
    summary: row.summary,
    decisions,
    instruction: row.instruction,
    slackTeamId: row.slack_team_id,
    slackChannelId: row.slack_channel_id,
    slackThreadTs: row.slack_thread_ts,
    sourceMessageTs: row.source_message_ts,
    sourcePermalink: row.source_permalink,
    sourceMessageCount: row.source_message_count,
    sourceTruncated: row.source_truncated === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    personaId: row.persona_id,
    summarizerModel: row.summarizer_model,
  };
}

function channelClause(channelIds?: string[]): { sql: string; values: string[] } {
  if (!channelIds) return { sql: "", values: [] };
  if (channelIds.length === 0) return { sql: " AND 0", values: [] };
  return {
    sql: ` AND slack_channel_id IN (${channelIds.map(() => "?").join(",")})`,
    values: channelIds,
  };
}

export function create(input: CreateDecisionNote): { note: DecisionNote; created: boolean } {
  const id = randomUUID();
  const createdAt = Date.now();
  const result = db.run(
    `INSERT OR IGNORE INTO decision_notes
      (id, tag, title, summary, decisions_json, instruction,
       slack_team_id, slack_channel_id, slack_thread_ts, source_message_ts,
       source_permalink, source_message_count, source_truncated, created_by,
       created_at, persona_id, summarizer_model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.tag,
      input.title,
      input.summary,
      JSON.stringify(input.decisions),
      input.instruction ?? null,
      input.slackTeamId,
      input.slackChannelId,
      input.slackThreadTs,
      input.sourceMessageTs,
      input.sourcePermalink,
      input.sourceMessageCount,
      input.sourceTruncated ? 1 : 0,
      input.createdBy,
      createdAt,
      input.personaId,
      input.summarizerModel,
    ],
  );
  const note = findBySource({
    ...input,
    slackChannelId: input.slackChannelId,
    sourceMessageTs: input.sourceMessageTs,
  });
  if (!note) throw new Error("decision note insert did not produce a row");
  return { note, created: result.changes > 0 };
}

export function findBySource(input: DecisionNoteScope & {
  tag: string;
  slackChannelId: string;
  sourceMessageTs: string;
}): DecisionNote | null {
  const row = db.query(
    `SELECT * FROM decision_notes
     WHERE slack_team_id = ? AND persona_id = ? AND tag = ?
       AND slack_channel_id = ? AND source_message_ts = ?`,
  ).get(
    input.slackTeamId,
    input.personaId,
    input.tag,
    input.slackChannelId,
    input.sourceMessageTs,
  ) as DecisionNoteRow | null;
  return row ? fromRow(row) : null;
}

export function listByTag(
  scope: DecisionNoteScope,
  tag: string,
  opts: { channelIds?: string[]; limit?: number } = {},
): DecisionNote[] {
  const channels = channelClause(opts.channelIds);
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 1000));
  const rows = db.query(
    `SELECT * FROM decision_notes
     WHERE slack_team_id = ? AND persona_id = ? AND tag = ?${channels.sql}
     ORDER BY created_at DESC, source_message_ts DESC, id DESC LIMIT ?`,
  ).all(scope.slackTeamId, scope.personaId, tag, ...channels.values, limit) as DecisionNoteRow[];
  return rows.map(fromRow);
}

export function countByTag(scope: DecisionNoteScope, tag: string, channelIds?: string[]): number {
  const channels = channelClause(channelIds);
  const row = db.query(
    `SELECT COUNT(*) AS count FROM decision_notes
     WHERE slack_team_id = ? AND persona_id = ? AND tag = ?${channels.sql}`,
  ).get(scope.slackTeamId, scope.personaId, tag, ...channels.values) as { count: number };
  return row.count;
}

export function listTags(
  scope: DecisionNoteScope,
  opts: { channelIds?: string[]; limit?: number } = {},
): { tags: DecisionTagSummary[]; total: number } {
  const channels = channelClause(opts.channelIds);
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 50));
  const rows = db.query(
    `SELECT tag, COUNT(*) AS count, MAX(created_at) AS latest_created_at
     FROM decision_notes
     WHERE slack_team_id = ? AND persona_id = ?${channels.sql}
     GROUP BY tag
     ORDER BY latest_created_at DESC, tag ASC
     LIMIT ?`,
  ).all(scope.slackTeamId, scope.personaId, ...channels.values, limit) as Array<{
    tag: string;
    count: number;
    latest_created_at: number;
  }>;
  const totalRow = db.query(
    `SELECT COUNT(DISTINCT tag) AS count FROM decision_notes
     WHERE slack_team_id = ? AND persona_id = ?${channels.sql}`,
  ).get(scope.slackTeamId, scope.personaId, ...channels.values) as { count: number };
  const tags = rows.map((row) => {
    const latest = db.query(
      `SELECT * FROM decision_notes
       WHERE slack_team_id = ? AND persona_id = ? AND tag = ?${channels.sql}
       ORDER BY created_at DESC, source_message_ts DESC, id DESC LIMIT 1`,
    ).get(scope.slackTeamId, scope.personaId, row.tag, ...channels.values) as DecisionNoteRow;
    return { tag: row.tag, count: row.count, latest: fromRow(latest) };
  });
  return { tags, total: totalRow.count };
}

export function listSourceChannels(scope: DecisionNoteScope): string[] {
  const rows = db.query(
    `SELECT DISTINCT slack_channel_id FROM decision_notes
     WHERE slack_team_id = ? AND persona_id = ?`,
  ).all(scope.slackTeamId, scope.personaId) as Array<{ slack_channel_id: string }>;
  return rows.map((row) => row.slack_channel_id);
}

export function clearForTests(): void {
  db.run("DELETE FROM decision_notes");
}
