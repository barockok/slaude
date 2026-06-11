import { join } from "node:path";
import { db } from "../db/schema";
import { brainCall, embeddingActive, getBrain } from "./brain";
import { AGENT_SOURCE, type BrainScope } from "./scope";
import { truncate } from "../memory/sqlite-provider";

/**
 * One-shot "dream the past": import historical sqlite memory_turns (the
 * pre-brain memory store) into the brain as conversation pages + timeline
 * entries in the agent source — the same shape BrainMemoryProvider writes
 * for new turns. After this, search/extraction/consolidation cover the
 * backlog. Idempotent: gbrain's timeline dedup index drops repeats of
 * (page, date, source, summary), so re-runs no-op.
 */

const AGENT_SCOPE: BrainScope = {
  clientId: "agent",
  sourceId: AGENT_SOURCE,
  allowedSources: [AGENT_SOURCE],
};

export interface BackfillResult {
  sessions: number;
  turns: number;
  errors: number;
}

type TurnRow = { session_id: string; ts: number; user_text: string; assistant_text: string };

export async function backfillMemoryTurns(
  log: (m: string) => void = () => {},
): Promise<BackfillResult> {
  const rows = db
    .query("SELECT session_id, ts, user_text, assistant_text FROM memory_turns ORDER BY session_id, ts")
    .all() as TurnRow[];

  const bySession = new Map<string, TurnRow[]>();
  for (const r of rows) {
    const list = bySession.get(r.session_id) ?? [];
    list.push(r);
    bySession.set(r.session_id, list);
  }

  let turns = 0;
  let errors = 0;
  let done = 0;
  for (const [sessionId, sessionTurns] of bySession) {
    const slug = `conversations/${sessionId.toLowerCase()}`;
    try {
      // Transcript goes in the page BODY: timeline entries aren't chunk-indexed,
      // so body text is what makes the session keyword/vector searchable.
      // Deterministic content → unchanged content hash on re-run → no churn.
      const body = sessionTurns
        .map((t) => {
          const day = new Date(t.ts).toISOString().slice(0, 10);
          return `- ${day} **user:** ${truncate(t.user_text, 800)}\n  **assistant:** ${truncate(t.assistant_text, 800)}`;
        })
        .join("\n")
        .slice(0, 120_000);
      await brainCall(
        "put_page",
        {
          slug,
          content: `---\ntype: conversation\n---\n# Conversation ${sessionId}\n\nBackfilled Slack session transcript.\n\n${body}\n`,
        },
        AGENT_SCOPE,
      );
      for (const t of sessionTurns) {
        await brainCall(
          "add_timeline_entry",
          {
            slug,
            date: new Date(t.ts).toISOString().slice(0, 10),
            source: "slack-turn",
            summary: truncate(t.user_text, 200),
            detail: `<user>${truncate(t.user_text, 800)}</user>\n<assistant>${truncate(t.assistant_text, 800)}</assistant>`,
          },
          AGENT_SCOPE,
        );
        turns++;
      }
    } catch (e) {
      errors++;
      log(`[backfill] session ${sessionId} failed: ${e instanceof Error ? e.message : e}`);
    }
    done++;
    if (done % 25 === 0) log(`[backfill] ${done}/${bySession.size} sessions`);
  }
  return { sessions: bySession.size, turns, errors };
}

/**
 * Embed stale chunks (everything put_page created that sync never touched —
 * backfilled conversations, agent memory, shared pages). No-op unless the
 * embedding gateway is active. runEmbedCore isn't in gbrain's exports map.
 */
export async function embedStaleChunks(log: (m: string) => void = () => {}): Promise<{ embedded: number } | null> {
  if (!embeddingActive()) {
    log("[backfill] embedding gateway inactive — skipping embed sweep");
    return null;
  }
  const engine = await getBrain();
  const { runEmbedCore } = (await import(
    join(import.meta.dir, "../../node_modules/gbrain/src/commands/embed.ts")
  )) as { runEmbedCore: (e: unknown, o: Record<string, unknown>) => Promise<{ embedded?: number; chunks_embedded?: number }> };
  const r = await runEmbedCore(engine, { stale: true });
  const embedded = r.embedded ?? r.chunks_embedded ?? 0;
  log(`[backfill] embedded ${embedded} stale chunk(s)`);
  return { embedded };
}
