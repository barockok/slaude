import { db } from "../db/schema";
import type { MemoryProvider, SyncTurn } from "./provider";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  user_text TEXT NOT NULL,
  assistant_text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_turns_session ON memory_turns (session_id, ts);

CREATE TABLE IF NOT EXISTS memory_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  scope TEXT NOT NULL DEFAULT 'session',
  ts INTEGER NOT NULL,
  fact TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_facts_session ON memory_facts (session_id);
CREATE INDEX IF NOT EXISTS idx_memory_facts_scope ON memory_facts (scope);
`;
for (const stmt of SCHEMA.split(";")) {
  const s = stmt.trim();
  if (s) db.run(s);
}

export class SqliteMemoryProvider implements MemoryProvider {
  /** How many recent turns to surface in <memory-context>. */
  recentTurnLimit = 5;

  async prefetch(sessionId: string): Promise<string | null> {
    const turns = db
      .query(
        `SELECT user_text, assistant_text FROM memory_turns
         WHERE session_id = ? ORDER BY ts DESC LIMIT ?`,
      )
      .all(sessionId, this.recentTurnLimit) as Array<{
      user_text: string;
      assistant_text: string;
    }>;

    const facts = db
      .query(
        `SELECT fact FROM memory_facts
         WHERE scope = 'global' OR session_id = ?
         ORDER BY ts DESC LIMIT 50`,
      )
      .all(sessionId) as Array<{ fact: string }>;

    if (turns.length === 0 && facts.length === 0) return null;

    const lines: string[] = [];
    if (facts.length) {
      lines.push("<facts>");
      for (const f of facts) lines.push(`- ${f.fact}`);
      lines.push("</facts>");
    }
    if (turns.length) {
      lines.push("<recent-turns>");
      for (const t of turns.reverse()) {
        lines.push(`<user>${truncate(t.user_text, 800)}</user>`);
        lines.push(`<assistant>${truncate(t.assistant_text, 800)}</assistant>`);
      }
      lines.push("</recent-turns>");
    }
    return lines.join("\n");
  }

  async syncTurn(t: SyncTurn): Promise<void> {
    db.run(
      `INSERT INTO memory_turns (session_id, ts, user_text, assistant_text)
       VALUES (?, ?, ?, ?)`,
      [t.sessionId, Date.now(), t.user, t.assistant],
    );
  }

  /** Manually record a fact (used by future memory tool). */
  recordFact(fact: string, opts: { sessionId?: string; scope?: "session" | "global" } = {}) {
    db.run(
      `INSERT INTO memory_facts (session_id, scope, ts, fact) VALUES (?, ?, ?, ?)`,
      [opts.sessionId ?? null, opts.scope ?? (opts.sessionId ? "session" : "global"), Date.now(), fact],
    );
  }
}

export function truncate(s: string, max: number) {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

export const memory = new SqliteMemoryProvider();
