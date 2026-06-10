import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { brainAdminCall, embeddingConfigured } from "./brain";
import { loadKbs } from "./loader";
import { kbSourceId } from "./scope";

export interface KbSyncResult {
  label: string;
  ok: boolean;
  error?: string;
}

/**
 * gbrain's sync requires a git repo (commit-based checkpoints), but installed
 * KBs often ship content-only (image bake / `slaude install` copy drops .git).
 * Self-init a local checkpoint repo — never pushed anywhere, purely so sync
 * can diff between runs. Re-runs commit any drift since the last sync.
 */
function ensureGitRepo(repo: string): void {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, "-c", "user.email=slaude@local", "-c", "user.name=slaude", ...args], { stdio: "pipe" });
  if (!existsSync(join(repo, ".git"))) git("init", "-q");
  try {
    git("add", "-A");
    git("commit", "-q", "-m", "slaude brain sync checkpoint");
  } catch {
    // clean tree (nothing to commit) or transient index issue — sync proceeds
    // off the existing HEAD either way
  }
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
      ensureGitRepo(repo);
      await brainAdminCall("sync_brain", { repo, no_pull: true, no_embed: !embeddingConfigured() }, sourceId);
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
