import { existsSync } from "node:fs";
import { join } from "node:path";
import { brainAdminCall, getBrain } from "./brain";
import { embedStaleChunks } from "./brain-backfill";
import { syncKbWikis, type KbSyncResult } from "./brain-sync";
import { loadKbs } from "./loader";
import { kbSourceId } from "./scope";

/**
 * Nightly brain maintenance — the slice of gbrain's dream cycle that runs
 * without API keys and inside slaude's process (PGLite is single-writer, so
 * an external `gbrain dream` subprocess can't run while the server holds the
 * engine). Phases: KB wiki re-sync → graph/timeline extraction per wiki →
 * orphan report → purge of expired soft-deletes.
 */

export interface ExtractPhaseResult {
  sourceId: string;
  ok: boolean;
  linksCreated?: number;
  error?: string;
}

export interface MaintenanceReport {
  kbSync: KbSyncResult[];
  extract: ExtractPhaseResult[];
  embed: { ok: boolean; embedded?: number; skipped?: boolean; error?: string };
  orphans: { ok: boolean; count?: number; error?: string };
  purge: { ok: boolean; error?: string };
}

// Same erased-specifier trick as brain.ts — tsc must not descend into gbrain.
const gbrainImport = (subpath: string): Promise<Record<string, unknown>> =>
  import(("gbrain/" + subpath) as string) as Promise<Record<string, unknown>>;

async function extractWiki(sourceId: string, dir: string): Promise<ExtractPhaseResult> {
  const prev = process.env.GBRAIN_SOURCE;
  process.env.GBRAIN_SOURCE = sourceId;
  try {
    const engine = await getBrain();
    const { runExtractCore } = (await gbrainImport("extract")) as {
      runExtractCore: (engine: unknown, opts: { mode: string; dir: string }) => Promise<{ links_created: number }>;
    };
    const r = await runExtractCore(engine, { mode: "all", dir });
    return { sourceId, ok: true, linksCreated: r.links_created };
  } catch (e) {
    return { sourceId, ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (prev === undefined) delete process.env.GBRAIN_SOURCE;
    else process.env.GBRAIN_SOURCE = prev;
  }
}

export async function runNightlyMaintenance(): Promise<MaintenanceReport> {
  const kbSync = await syncKbWikis();

  const extract: ExtractPhaseResult[] = [];
  for (const kb of loadKbs()) {
    const wikiDir = join(kb.path, "wiki");
    const dir = existsSync(wikiDir) ? wikiDir : kb.path;
    extract.push(await extractWiki(kbSourceId(kb.label), dir));
  }

  // Embed sweep covers chunks created by put_page (agent memory, shared
  // pages, backfills) that sync never touches. No-op when gateway inactive.
  let embed: MaintenanceReport["embed"];
  try {
    const r = await embedStaleChunks();
    embed = r ? { ok: true, embedded: r.embedded } : { ok: true, skipped: true };
  } catch (e) {
    embed = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  let orphans: MaintenanceReport["orphans"];
  try {
    const r = (await brainAdminCall("find_orphans", {})) as { orphans?: unknown[] } | unknown[];
    const count = Array.isArray(r) ? r.length : (r.orphans?.length ?? 0);
    orphans = { ok: true, count };
  } catch (e) {
    orphans = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  let purge: MaintenanceReport["purge"];
  try {
    await brainAdminCall("purge_deleted_pages", {});
    purge = { ok: true };
  } catch (e) {
    purge = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  return { kbSync, extract, embed, orphans, purge };
}

/** Milliseconds until the next local occurrence of hh:mm. */
export function msUntilNext(hour: number, minute: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/** Parse "HH:MM" (24h). Returns null for "off"/invalid. */
export function parseCycleTime(spec: string | undefined): { hour: number; minute: number } | null {
  if (!spec || spec === "off") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(spec);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Schedule the nightly cycle. Default 03:00 local; SLAUDE_BRAIN_CYCLE
 * overrides ("HH:MM" or "off"). Returns a cancel function.
 */
export function scheduleNightlyMaintenance(
  onReport: (r: MaintenanceReport) => void = (r) => console.log("[brain] nightly maintenance:", JSON.stringify(r)),
): () => void {
  const time = parseCycleTime(process.env.SLAUDE_BRAIN_CYCLE ?? "03:00");
  if (!time) return () => {};
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => {
    timer = setTimeout(async () => {
      try {
        onReport(await runNightlyMaintenance());
      } catch (e) {
        console.error("[brain] nightly maintenance failed:", e instanceof Error ? e.message : e);
      }
      arm();
    }, msUntilNext(time.hour, time.minute));
    // Never hold the process open for the next cycle (tests, shutdown).
    timer.unref?.();
  };
  arm();
  return () => clearTimeout(timer);
}
