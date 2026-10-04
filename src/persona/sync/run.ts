/**
 * One sync, in two phases. Phase one runs outside any transaction: parse,
 * resolve placeholders, and extract the structured soul for every soul whose
 * text changed. No model call ever runs while database locks are held. Phase
 * two is the single transaction in applySync. Any failure in phase one applies
 * nothing. Messages name a variable, persona or revision, never a value.
 */
import { parsePayload, resolvePlaceholders, unknownFieldPaths, capPaths, MAX_REPORTED_FIELDS, SUPPORTED_PAYLOAD_VERSION, PayloadError } from "./payload";
import { extractSoulData } from "../../soul/extract";
import {
  applySync, desiredPersonas, effectivePersonas, syncState, StaleRevisionError, type ApplyResult,
} from "../../db/personas";
import { sameDesired, type DesiredPersona } from "../effective";

export class SyncFailure extends Error {
  constructor(readonly status: 409 | 422 | 502, message: string) { super(message); }
}
export type SyncReport = ApplyResult & {
  revision: string; dryRun: boolean; ignoredFields: string[]; ignoredFieldsTotal: number;
  /** Applied anyway, reported by persona name (e.g. a label no live node carries). */
  warnings: string[];
};

/**
 * A persona whose `runsOn` no live node carries is a warning, not an error
 * (node labels spec §4.5): the nodes may simply not be up yet. Its turns wait
 * on the label queue until a node with the label starts.
 */
export function unservedLabelWarnings(rows: ReadonlyArray<{ name: string; runsOn?: string | null }>, live: ReadonlySet<string>): string[] {
  return rows
    .filter((r) => r.runsOn && !live.has(r.runsOn))
    .map((r) => `persona '${r.name}': no live node carries label '${r.runsOn}'; its turns wait until one does`);
}

export async function runSync(
  tenant: string,
  raw: unknown,
  opts: {
    dryRun: boolean; env: Record<string, string | undefined>; by: string; extract?: (text: string) => Promise<unknown>;
    /** The labels live nodes carry (the registry's node-label view). Absent
     *  (no queue: a single process) = no label warnings. */
    liveLabels?: () => Promise<ReadonlySet<string>>;
  },
): Promise<SyncReport> {
  const extract = opts.extract ?? ((t: string) => extractSoulData(t, { strict: true }));
  let payload;
  const allIgnored = unknownFieldPaths(raw);
  const ignoredFields = allIgnored.slice(0, MAX_REPORTED_FIELDS);
  const ignoredFieldsTotal = allIgnored.length;
  try {
    // The version check comes first so a newer payload always gets the
    // upgrade message, not a complaint about its new fields.
    const v = raw && typeof raw === "object" ? (raw as { version?: unknown }).version : undefined;
    if (typeof v === "number" && Number.isInteger(v) && v > SUPPORTED_PAYLOAD_VERSION) parsePayload(raw);
    if (opts.env.SLAUDE_DEPLOY_STRICT !== undefined && !["0", "1"].includes(opts.env.SLAUDE_DEPLOY_STRICT)) {
      console.warn("[persona-sync] SLAUDE_DEPLOY_STRICT is set to a value other than 0 or 1; strict mode is OFF");
    }
    // Stage two (opt-in): a field this gateway does not know is an error, not
    // a silent drop. Names only, never values.
    if (allIgnored.length && opts.env.SLAUDE_DEPLOY_STRICT === "1") {
      throw new PayloadError(`unknown field(s) refused under SLAUDE_DEPLOY_STRICT: ${capPaths(allIgnored).join(", ")}`);
    }
    payload = parsePayload(raw);
    if (payload.personas.length === 0 && !payload.allowEmpty) {
      throw new PayloadError("refusing an empty persona set; set allowEmpty: true to retire every persona");
    }
    // A managed tenant reads the default persona's soul from its `default` row
    // and nowhere else, so a set that omits it would leave that persona with no
    // source at all.
    if (payload.personas.length > 0 && !payload.personas.some((p) => p.name === "default")) {
      throw new PayloadError("payload must include the default persona");
    }
    payload = { ...payload, personas: payload.personas.map((p) => resolvePlaceholders(p, opts.env)) };
  } catch (e) {
    if (e instanceof PayloadError) throw new SyncFailure(422, e.message);
    throw e;
  }

  // Fail a stale payload before spending any model call. applySync's
  // transactional compare-and-set remains the authority; this is a fast path.
  const live = await syncState(tenant);
  if (live && live.committedAt > Date.parse(payload.committedAt)) {
    throw new SyncFailure(409, `a newer revision is live (${live.revision})`);
  }

  // Both layers, read once each. Desired is what the merge compares against;
  // effective is only needed for which fields carry a live override.
  const desired = new Map((await desiredPersonas(tenant, { includeTombstoned: true })).map((p) => [p.name, p]));
  const effective = new Map((await effectivePersonas(tenant, { includeTombstoned: true })).map((p) => [p.name, p]));

  const rows: DesiredPersona[] = [];
  for (const p of payload.personas) {
    const prev = desired.get(p.name);
    let soulJson: unknown;
    if (prev && prev.soulMd === p.soul && !effective.get(p.name)?.overridden.includes("soul")) {
      soulJson = prev.soulJson; // unchanged soul: no model call
    } else if (opts.dryRun) {
      // A dry run reports created/updated/unchanged, which never depends on the
      // structured soul. Extracting here would let any caller with the preview
      // token spend model calls (and write the extraction cache) per request.
      soulJson = null;
    } else {
      try {
        soulJson = await extract(p.soul);
      } catch (e) {
        const cls = e instanceof Error ? e.constructor.name : typeof e;
        const msg = (e instanceof Error ? e.message : String(e)).slice(0, 200);
        console.error(`[persona-sync] soul extraction failed persona=${p.name}: ${cls}: ${msg}`);
        throw new SyncFailure(502, `soul extraction failed for persona '${p.name}'`);
      }
    }
    rows.push({
      name: p.name, slackUserId: p.slackUserId ?? null, userToken: p.userToken ?? null, model: p.model ?? null,
      soulMd: p.soul, soulJson, mcp: p.mcp ?? null, runsOn: p.runsOn ?? null, origin: "git", tombstonedAt: null,
    });
  }

  if (allIgnored.length) {
    console.warn(`[persona-sync] ignored unknown payload fields tenant=${tenant}: ${capPaths(allIgnored).join(", ")}`);
  }
  const meta = { revision: payload.revision, committedAt: Date.parse(payload.committedAt), by: opts.by };

  let warnings: string[] = [];
  if (opts.liveLabels && rows.some((r) => r.runsOn)) {
    try {
      warnings = unservedLabelWarnings(rows, await opts.liveLabels());
    } catch (e) {
      // The check is advisory: a Redis hiccup must not fail a deploy.
      console.warn(`[persona-sync] could not read live node labels tenant=${tenant}: ${(e as Error).message}`);
    }
    for (const w of warnings) console.warn(`[persona-sync] tenant=${tenant} ${w}`);
  }

  if (opts.dryRun) {
    const incoming = new Set(rows.map((r) => r.name));
    const report: SyncReport = { created: [], updated: [], unchanged: [], tombstoned: [], overridesWiped: 0, revision: meta.revision, dryRun: true, ignoredFields, ignoredFieldsTotal, warnings };
    // Same rule as applySync.
    for (const r of rows) {
      const prev = desired.get(r.name);
      if (!prev) report.created.push(r.name);
      else if (prev.origin === "git" && sameDesired(prev, r)) report.unchanged.push(r.name);
      else report.updated.push(r.name);
    }
    for (const [name, prev] of desired) if (!incoming.has(name) && prev.tombstonedAt === null) report.tombstoned.push(name);
    // setOverride refuses names without a live persona, so no orphan rows exist
    // and this equals the count applySync's DELETE reports.
    report.overridesWiped = [...effective.values()].reduce((n, p) => n + p.overridden.length, 0);
    return report;
  }

  try {
    return { ...(await applySync(tenant, rows, meta)), revision: meta.revision, dryRun: false, ignoredFields, ignoredFieldsTotal, warnings };
  } catch (e) {
    if (e instanceof StaleRevisionError) throw new SyncFailure(409, e.message);
    throw e;
  }
}
