import { db } from "../db/schema";
import type { MemoryProvider, SyncTurn } from "./provider";

/**
 * Flat turns + facts memory store on the process DB (sqlite or Postgres via
 * the db client seam). Tables: memory_turns, memory_facts. Historically the
 * "sqlite" provider; the name is kept for the SLAUDE_MEMORY=sqlite switch.
 */
export class SqliteMemoryProvider implements MemoryProvider {
  /** How many recent turns to surface in <memory-context>. */
  recentTurnLimit = 5;

  async prefetch(sessionId: string): Promise<string | null> {
    const turns = await db.query<{ user_text: string; assistant_text: string }>(
      `SELECT user_text, assistant_text FROM memory_turns
       WHERE session_id = ? ORDER BY ts DESC LIMIT ?`,
      [sessionId, this.recentTurnLimit],
    );

    const facts = await db.query<{ fact: string }>(
      `SELECT fact FROM memory_facts
       WHERE scope = 'global' OR session_id = ?
       ORDER BY ts DESC LIMIT 50`,
      [sessionId],
    );

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
    await db.run(
      `INSERT INTO memory_turns (session_id, ts, user_text, assistant_text)
       VALUES (?, ?, ?, ?)`,
      [t.sessionId, Date.now(), t.user, t.assistant],
    );
  }

  /** Manually record a fact (used by future memory tool). */
  async recordFact(fact: string, opts: { sessionId?: string; scope?: "session" | "global" } = {}): Promise<void> {
    await db.run(
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
