/**
 * Session enumerator (design §1). The one list-all view: durable truth
 * (Postgres/sqlite `sessions` rows) ∩ live truth (Redis warm registry).
 *
 * `listSessions` (db layer) gives newest-first rows; here each row is joined
 * against the warm registry (`sess:<id>` → {node, since, lastBeat, fresh}) to
 * mark whether it is warm on a node right now, and which. Cold / no-registry /
 * no-Redis degrades gracefully to `warm:false` rather than erroring — a mono
 * deploy without Redis still lists every session.
 */
import * as Sessions from "../../db/sessions";
import type { SessionRow } from "../../db/schema";
import type { Registry } from "../../queue/registry";

export interface SessionSummary {
  id: string;
  persona_id: string;
  model: string;
  status: string;
  claude_started: number;
  engaged: number;
  title: string | null;
  working_dir: string;
  slack_team_id: string | null;
  slack_channel_id: string | null;
  slack_thread_ts: string | null;
  created_at: number;
  updated_at: number;
  /** Postgres carries tenant_id (P1); sqlite does not — present only when the row has it. */
  tenant_id?: string;
  /** Warm on a node right now (registry hit). */
  warm: boolean;
  /** Owning node id when warm. */
  node?: string;
  /** Operator currently driving this session via the panel, if any. */
  panel_locked_by?: string;
}

export interface EnumerateDeps {
  registry?: Registry | null;
  /** Panel active-surface lock owner lookup (optional enrichment). */
  panelOwner?: (sessionId: string) => Promise<string | null>;
}

function summarize(row: SessionRow): SessionSummary {
  const s: SessionSummary = {
    id: row.id,
    persona_id: row.persona_id,
    model: row.model,
    status: row.status,
    claude_started: row.claude_started,
    engaged: row.engaged,
    title: row.title,
    working_dir: row.working_dir,
    slack_team_id: row.slack_team_id,
    slack_channel_id: row.slack_channel_id,
    slack_thread_ts: row.slack_thread_ts,
    created_at: row.created_at,
    updated_at: row.updated_at,
    warm: false,
  };
  const tenant = (row as any).tenant_id;
  if (tenant !== undefined && tenant !== null) s.tenant_id = tenant;
  return s;
}

/**
 * List sessions enriched with warm/cold + owning node (and, when a lock
 * lookup is provided, the driving operator). Registry / lock failures are
 * swallowed per-row so one bad Redis call never blanks the whole list.
 */
export async function enumerateSessions(
  o: Sessions.ListSessionsOpts,
  deps: EnumerateDeps,
): Promise<SessionSummary[]> {
  const rows = await Sessions.listSessions(o);
  return Promise.all(
    rows.map(async (row) => {
      const s = summarize(row);
      if (deps.registry) {
        try {
          const loc = await deps.registry.lookup(row.id);
          if (loc && loc.fresh) {
            s.warm = true;
            s.node = loc.node;
          }
        } catch {
          /* cold/unknown — leave warm:false */
        }
      }
      if (deps.panelOwner) {
        try {
          const owner = await deps.panelOwner(row.id);
          if (owner) s.panel_locked_by = owner;
        } catch {
          /* lock lookup best-effort */
        }
      }
      return s;
    }),
  );
}
