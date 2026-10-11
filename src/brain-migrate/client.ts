import { createHash } from "node:crypto";
import { batchPages, readPages, verifyBundle, type BundlePage } from "./bundle";
import { isAgentLike } from "./remap";

export class ImportError extends Error {}
export interface SourceCounts { written: number; skipped: number; overwritten: number; failed: number; linksWritten: number; linksDropped: number; linksFailed: number; linksOutOfScope: number; noEmbedding: number }
export interface ImportSummary {
  agentSource: string | null;
  sources: Record<string, SourceCounts>;
  failedSlugs: string[];
  failedReasons: Record<string, number>;
  mismatches: string[];
  /** Links written by the automatic heal pass (links to pages that arrived in a later batch). */
  linksHealed: number;
  /** Same-slug pages from different sources importing into one slice; sources only, never slugs. */
  collisions: { count: number; sources: string[] };
}
export interface ImportClientOptions {
  gateway: string; persona: string; token: string; bundle: string;
  dryRun?: boolean; onConflict?: "skip" | "overwrite" | "fail"; map?: Record<string, string>;
  fetchImpl?: typeof fetch; timeoutMs?: number; sleep?: (ms: number) => Promise<void>; log?: (l: string) => void;
}

const isKb = (s: string): boolean => s.startsWith("kb-");
const emptyCounts = (): SourceCounts => ({ written: 0, skipped: 0, overwritten: 0, failed: 0, linksWritten: 0, linksDropped: 0, linksFailed: 0, linksOutOfScope: 0, noEmbedding: 0 });

// kb-* is checked first: a map key cannot opt a kb source in.
const COVERED = (s: string, map: Record<string, string>): boolean =>
  !isKb(s) && (Object.hasOwn(map, s) || isAgentLike(s) || s === "shared" || s === "public" || /^user-[a-z0-9]+$/.test(s));

const AGENT = "__agent__";

/** Did anything go wrong that the operator must look at? Drives the CLI exit code. */
export function hasProblems(s: ImportSummary): boolean {
  return s.failedSlugs.length > 0 || s.mismatches.length > 0
    || Object.values(s.sources).some((c) => c.failed > 0 || c.linksFailed > 0);
}

export async function runImport(o: ImportClientOptions): Promise<ImportSummary> {
  const doFetch = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = o.log ?? (() => {});
  const map = o.map ?? {};
  for (const [from, to] of Object.entries(map)) {
    if (isKb(to)) throw new ImportError(`--map ${from}=${to}: kb-* sources are never an import target`);
  }
  const manifest = await verifyBundle(o.bundle); // throws before any request on a bad checksum
  for (const s of manifest.sources) {
    if (isKb(s.id)) throw new ImportError(`source '${s.id}': kb-* sources are never imported; re-export without them`);
  }
  const uncovered = manifest.sources.map((s) => s.id).filter((s) => !COVERED(s, map));
  if (uncovered.length) throw new ImportError(`source(s) with no mapping: ${uncovered.join(", ")} (use --map from=to)`);

  const url = `${o.gateway.replace(/\/$/, "")}/brain-import/v1/personas/${encodeURIComponent(o.persona)}`;
  const timeoutMs = o.timeoutMs ?? 120_000;
  const dryRun = o.dryRun ?? false;
  const onConflict = o.onConflict ?? "skip";

  interface PassResult { sources: Record<string, SourceCounts>; failedSlugs: string[]; failedReasons: Record<string, number>; agentSource: string | null }
  // One streaming pass over the bundle. `collide` is only given on the first pass.
  async function pass(policy: "skip" | "overwrite" | "fail", dry: boolean, collide?: (p: BundlePage) => void): Promise<PassResult> {
    const sources: Record<string, SourceCounts> = {};
    const failedSlugs: string[] = [];
    const failedReasons: Record<string, number> = {};
    let agentSource: string | null = null;
    const tap = async function* (): AsyncGenerator<BundlePage> {
      for await (const p of readPages(o.bundle)) { collide?.(p); yield p; }
    };
    for await (const batch of batchPages(tap(), 100, 1_000_000)) {
      const body = JSON.stringify({
        dryRun: dry, onConflict: policy, ...(o.map ? { map: o.map } : {}),
        engine: { embeddingModel: manifest.engine.embeddingModel, embeddingDimensions: manifest.engine.embeddingDimensions },
        pages: batch,
      });
      let res: Response | null = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          res = await doFetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${o.token}` }, body, signal: AbortSignal.timeout(timeoutMs) });
          if (res.status < 500 && res.status !== 429) break;
        } catch { res = null; }
        if (attempt < 4) await sleep(Math.min(30_000, 500 * 2 ** attempt));
      }
      if (!res || res.status >= 500 || res.status === 429) throw new ImportError(`gateway unavailable after retries (${res?.status ?? "network error"})`);
      const j = (await res.json().catch(() => ({}))) as { error?: string; agentSource?: string; sources?: Record<string, Partial<SourceCounts>>; failedSlugs?: string[]; failedReasons?: Record<string, number> };
      if (res.status >= 400) throw new ImportError(`gateway refused the batch (${res.status}): ${j.error ?? "no message"}`);
      agentSource = j.agentSource ?? agentSource;
      for (const [k, c] of Object.entries(j.sources ?? {})) {
        const t = (sources[k] ??= emptyCounts());
        for (const f of Object.keys(t) as Array<keyof SourceCounts>) t[f] += c[f] ?? 0;
      }
      failedSlugs.push(...(j.failedSlugs ?? []));
      for (const [r, n] of Object.entries(j.failedReasons ?? {})) failedReasons[r] = (failedReasons[r] ?? 0) + n;
      log(`batch of ${batch.length} sent`);
    }
    return { sources, failedSlugs, failedReasons, agentSource };
  }

  // In-bundle collisions: two sources that import into one slice and share a slug. Memory-bounded
  // (a digest per target+slug), value-free (reports source pairs only, never slugs).
  const seen = new Map<string, string>();
  const collisionPairs = new Set<string>();
  let collisionCount = 0;
  const collide = (p: BundlePage): void => {
    const target = Object.hasOwn(map, p.source) ? map[p.source]! : isAgentLike(p.source) ? AGENT : p.source;
    const key = createHash("sha1").update(target).update("\0").update(p.slug).digest("base64");
    const first = seen.get(key);
    if (first === undefined) { seen.set(key, p.source); return; }
    if (first !== p.source) { collisionCount++; collisionPairs.add([first, p.source].sort().join(" vs ")); }
  };

  const first = await pass(onConflict, dryRun, collide);
  const { sources, failedSlugs, failedReasons } = first;
  const agentSource = first.agentSource;
  if (collisionCount > 0) {
    log(`${collisionCount} in-bundle slug collision(s) between sources importing into one slice (${[...collisionPairs].join("; ")}): with skip the first copy written is kept (the export writes the most specific source first), with overwrite the last one wins.`);
  }

  const healable = (r: Record<string, SourceCounts>): number => Object.values(r).reduce((t, c) => t + Math.max(0, c.linksDropped - c.linksOutOfScope), 0);
  const outOfScope = Object.values(sources).reduce((t, c) => t + c.linksOutOfScope, 0);
  let linksHealed = 0;
  let remaining = healable(sources);
  // One automatic heal pass: skip is idempotent and now writes links, so links to pages that
  // arrived in a later batch land. Not after a fail policy (those pages are left untouched).
  if (!dryRun && remaining > 0 && onConflict !== "fail") {
    const second = await pass("skip", false);
    const w1 = Object.values(sources).reduce((t, c) => t + c.linksWritten, 0);
    const w2 = Object.values(second.sources).reduce((t, c) => t + c.linksWritten, 0);
    linksHealed = Math.max(0, w2 - w1);
    remaining = healable(second.sources);
    log(`heal pass: ${linksHealed} links written`);
  }
  if (!dryRun && remaining > 0) {
    log(`${remaining} links were not written because their target page was missing; re-run the same command (skip is idempotent) once the missing pages exist.`);
  }
  if (!dryRun && outOfScope > 0) log(`${outOfScope} links into kb-* or unmapped sources were not imported; those are never imported.`);

  // Reconcile: every manifest page must be accounted for by an outcome, keyed by the FINAL target.
  // The agent slice is a placeholder until the gateway reports its real id.
  const finalKey = (k: string): string => (agentSource && k === agentSource ? AGENT : k);
  const expected: Record<string, number> = {};
  for (const s of manifest.sources) {
    const target = Object.hasOwn(map, s.id) ? map[s.id]! : isAgentLike(s.id) ? AGENT : s.id;
    const key = finalKey(target);
    expected[key] = (expected[key] ?? 0) + s.pages;
  }
  const got: Record<string, number> = {};
  for (const [k, c] of Object.entries(sources)) {
    const key = finalKey(k);
    got[key] = (got[key] ?? 0) + c.written + c.skipped + c.overwritten + c.failed;
  }
  const mismatches: string[] = [];
  for (const k of new Set([...Object.keys(expected), ...Object.keys(got)])) {
    const e = expected[k] ?? 0, g = got[k] ?? 0;
    if (e !== g) mismatches.push(`${k === AGENT ? "agent slice" : k}: expected ${e} pages, gateway accounted for ${g}`);
  }
  return { agentSource, sources, failedSlugs, failedReasons, mismatches, linksHealed, collisions: { count: collisionCount, sources: [...collisionPairs] } };
}
