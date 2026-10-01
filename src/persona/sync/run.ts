/**
 * One sync, in two phases. Phase one runs outside any transaction: parse,
 * resolve placeholders, and extract the structured soul for every soul whose
 * text changed. No model call ever runs while database locks are held. Phase
 * two is the single transaction in applySync. Any failure in phase one applies
 * nothing. Messages name a variable, persona or revision, never a value.
 */
import { parsePayload, resolvePlaceholders, PayloadError } from "./payload";
import { extractSoulData } from "../../soul/extract";
import {
  applySync, desiredPersonas, effectivePersonas, syncState, StaleRevisionError, type ApplyResult,
} from "../../db/personas";
import { sameDesired, type DesiredPersona } from "../effective";

export class SyncFailure extends Error {
  constructor(readonly status: 409 | 422 | 502, message: string) { super(message); }
}
export type SyncReport = ApplyResult & { revision: string; dryRun: boolean };

export async function runSync(
  tenant: string,
  raw: unknown,
  opts: { dryRun: boolean; env: Record<string, string | undefined>; by: string; extract?: (text: string) => Promise<unknown> },
): Promise<SyncReport> {
  const extract = opts.extract ?? ((t: string) => extractSoulData(t, { strict: true }));
  let payload;
  try {
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
      soulMd: p.soul, soulJson, mcp: p.mcp ?? null, origin: "git", tombstonedAt: null,
    });
  }

  const meta = { revision: payload.revision, committedAt: Date.parse(payload.committedAt), by: opts.by };

  if (opts.dryRun) {
    const incoming = new Set(rows.map((r) => r.name));
    const report: SyncReport = { created: [], updated: [], unchanged: [], tombstoned: [], overridesWiped: 0, revision: meta.revision, dryRun: true };
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
    return { ...(await applySync(tenant, rows, meta)), revision: meta.revision, dryRun: false };
  } catch (e) {
    if (e instanceof StaleRevisionError) throw new SyncFailure(409, e.message);
    throw e;
  }
}
