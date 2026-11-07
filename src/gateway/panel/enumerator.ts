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
import { activityOf, type LocalSessions } from "./activity";
import type { SessionActivity } from "./api-types";

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
  /** Warm right now: a registry hit (gateway) or live in this process (mono). */
  warm: boolean;
  /** What the session is doing now; a stored `running` row nothing holds is `idle`. */
  activity: SessionActivity;
  /** Owning node id when warm. */
  node?: string;
  /** Operator currently driving this session via the panel, if any. */
  panel_locked_by?: string;
}

export interface EnumerateDeps {
  registry?: Registry | null;
  /** Mono: in-process liveness, used instead of the registry (nothing registers there). */
  local?: LocalSessions | null;
  /** Gateway: whether each warm session has a turn in flight (the event
   *  stream), for all of them in one batched call. */
  turnsInFlight?: (sessionIds: string[]) => Promise<Map<string, boolean | undefined>>;
  /** Panel active-surface lock owners, in order, for all rows in one call (optional enrichment). */
  panelOwners?: (sessionIds: string[]) => Promise<Array<string | null>>;
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
    activity: activityOf(row.status, false, undefined),
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
  const out = rows.map(summarize);
  if (deps.local) {
    for (const s of out) {
      s.warm = deps.local.isWarm(s.id);
      s.activity = activityOf(s.status, s.warm, s.warm && deps.local.turnInFlight(s.id));
    }
  } else if (deps.registry && out.length > 0) {
    // One pipelined registry read for the page, then the stream reads for the
    // warm rows (batched too): a bounded number of round trips per request.
    let locs: Array<{ node: string; fresh: boolean } | null> = [];
    try {
      locs = await deps.registry.lookupMany(out.map((s) => s.id));
    } catch {
      /* cold/unknown: leave warm:false */
    }
    out.forEach((s, i) => {
      const loc = locs[i];
      if (loc && loc.fresh) {
        s.warm = true;
        s.node = loc.node;
      }
    });
    const warm = out.filter((s) => s.warm).map((s) => s.id);
    const inFlight = warm.length > 0 && deps.turnsInFlight ? await deps.turnsInFlight(warm).catch(() => new Map<string, boolean | undefined>()) : new Map<string, boolean | undefined>();
    for (const s of out) s.activity = activityOf(s.status, s.warm, inFlight.get(s.id));
  }
  if (deps.panelOwners && out.length > 0) {
    try {
      const owners = await deps.panelOwners(out.map((s) => s.id));
      out.forEach((s, i) => {
        if (owners[i]) s.panel_locked_by = owners[i]!;
      });
    } catch {
      /* lock lookup best-effort */
    }
  }
  return out;
}
