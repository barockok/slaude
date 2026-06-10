import { existsSync } from "node:fs";
import { join } from "node:path";
import { brainAdminCall } from "./brain";
import { loadKbs } from "./loader";
import { kbSourceId } from "./scope";

export interface KbSyncResult {
  label: string;
  ok: boolean;
  error?: string;
}

/**
 * Import each installed KB's wiki/ into its kb-<label> brain source.
 * gbrain's sync source-routing falls back to "sole non-default source" when
 * ambiguous, so the target is pinned via GBRAIN_SOURCE for the duration of
 * each call (sequential — never parallelize this loop).
 */
export async function syncKbWikis(): Promise<KbSyncResult[]> {
  const out: KbSyncResult[] = [];
  for (const kb of loadKbs()) {
    const wikiDir = join(kb.path, "wiki");
    const repo = existsSync(wikiDir) ? wikiDir : kb.path;
    const sourceId = kbSourceId(kb.label);
    const prev = process.env.GBRAIN_SOURCE;
    process.env.GBRAIN_SOURCE = sourceId;
    try {
      await brainAdminCall("sync_brain", { repo, no_pull: true, no_embed: true }, sourceId);
      out.push({ label: kb.label, ok: true });
    } catch (e) {
      out.push({ label: kb.label, ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (prev === undefined) delete process.env.GBRAIN_SOURCE;
      else process.env.GBRAIN_SOURCE = prev;
    }
  }
  return out;
}
