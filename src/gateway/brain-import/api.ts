/**
 * The brain migration's door: a token-guarded write path into a persona's
 * memory. Its own prefix and token, like /deploy, and not mounted on a node.
 *
 *   POST /brain-import/v1/personas/:persona
 *
 * SLAUDE_BRAIN_IMPORT_TOKEN unset (or under 32 characters) means the route does
 * not exist: 404 for every path and method, before anything else is looked at.
 */
import { z } from "zod";
import { env } from "../../config/env";
import { timingSafeStringEqual } from "../api/auth";
import { json, readBodyCapped } from "../api/http";
import { applyPage, type OnConflict } from "../../brain-migrate/apply";
import type { BundlePage } from "../../brain-migrate/bundle";
import { embeddingMismatch, readEmbeddingInfo, type BrainConfigFile, type EmbeddingInfo } from "../../brain-migrate/embedding-info";
import type { MigrateEngine } from "../../brain-migrate/engine-types";
import { agentSourceForPersona, remapSource, validateMap } from "../../brain-migrate/remap";
import { agentIdReady } from "../../knowledge/agent-identity";
import { brainEnabled, brainHome, ensureSource as ensureBrainSource, getBrain } from "../../knowledge/brain";
import { brainMode } from "../../knowledge/brain-config";
import { livePersona } from "../../persona/registry";
import { join } from "node:path";
import { readFileSync } from "node:fs";

export const BRAIN_IMPORT_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const BRAIN_IMPORT_MAX_PAGES = 100;
const MIN_TOKEN_LENGTH = 32;

export interface BrainImportDeps {
  env?: () => Record<string, string | undefined>;
  engine?: () => Promise<MigrateEngine>;
  brainConfig?: () => EmbeddingInfo | Promise<EmbeddingInfo>;
  resolveAgentId?: (persona: string) => Promise<string | null>;
  ensureSource?: (id: string) => Promise<void>;
  brainOn?: () => { enabled: boolean; mode: "local" | "remote" };
  log?: (line: string) => void;
}

const pageSchema = z.object({
  source: z.string().min(1), slug: z.string().min(1), type: z.string(), title: z.string(),
  compiledTruth: z.string(), timeline: z.string(), frontmatter: z.record(z.unknown()), contentHash: z.string().nullable(),
  chunks: z.array(z.object({ index: z.number().int(), text: z.string(), source: z.enum(["compiled_truth", "timeline", "fenced_code"]), embedding: z.array(z.number()).nullable(), model: z.string().nullable(), tokens: z.number().nullable() })),
  tags: z.array(z.string()),
  timelineEntries: z.array(z.object({ date: z.string(), source: z.string(), summary: z.string(), detail: z.string() })),
  raw: z.array(z.object({ source: z.string(), data: z.record(z.unknown()) })),
  links: z.array(z.object({ toSource: z.string(), toSlug: z.string(), type: z.string(), context: z.string() })),
});
const bodySchema = z.object({
  dryRun: z.boolean().optional(),
  onConflict: z.enum(["skip", "overwrite", "fail"]).optional(),
  map: z.record(z.string()).optional(),
  engine: z.object({ embeddingModel: z.string().nullable(), embeddingDimensions: z.number().nullable() }),
  pages: z.array(pageSchema).max(BRAIN_IMPORT_MAX_PAGES),
}).strict();

async function defaultAgentId(persona: string): Promise<string | null> {
  if (persona === "default") return agentIdReady();
  try { return livePersona(persona)?.slackUserId || null; } catch { return null; }
}

function readConfigFile(): BrainConfigFile | null {
  try { return JSON.parse(readFileSync(join(brainHome(), "config.json"), "utf8")); } catch { return null; }
}

/** The live brain's own embedding shape, via the helper export uses. */
async function defaultBrainConfig(engine: MigrateEngine): Promise<EmbeddingInfo> {
  return readEmbeddingInfo(engine, readConfigFile);
}

interface SourceCounts { written: number; skipped: number; overwritten: number; failed: number; linksWritten: number; linksDropped: number; linksFailed: number; noEmbedding: number }

export function createBrainImportApi(deps: BrainImportDeps = {}) {
  const log = deps.log ?? ((l: string) => console.log(l));
  const token = (): string => {
    if (!deps.env) return env.brainImportToken();
    const t = (deps.env().SLAUDE_BRAIN_IMPORT_TOKEN ?? "").trim();
    return t.length < MIN_TOKEN_LENGTH ? "" : t;
  };

  async function fetch(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (url.pathname !== "/brain-import" && !url.pathname.startsWith("/brain-import/")) return null;
    const expected = token();
    if (!expected) return json(404, { error: "not found" });
    const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
    if (!m || !timingSafeStringEqual(m[1]!, expected)) return json(401, { error: "invalid or missing brain-import token" });

    const seg = url.pathname.split("/").filter(Boolean); // brain-import v1 personas :p
    if (!(seg.length === 4 && seg[1] === "v1" && seg[2] === "personas")) return json(404, { error: "not found" });
    if (req.method !== "POST") return json(405, { error: "method not allowed" });
    let persona: string;
    try { persona = decodeURIComponent(seg[3]!); } catch { return json(404, { error: "not found" }); }
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(persona)) return json(404, { error: "not found" });

    const on = (deps.brainOn ?? (() => ({ enabled: brainEnabled(), mode: brainMode() })))();
    if (!on.enabled) return json(409, { error: "the brain is disabled on this gateway" });
    if (on.mode === "remote") return json(409, { error: "brain import is not supported with SLAUDE_BRAIN_MODE=remote" });

    const text = await readBodyCapped(req, BRAIN_IMPORT_MAX_BODY_BYTES);
    if (text === null) return json(413, { error: `body exceeds ${BRAIN_IMPORT_MAX_BODY_BYTES} bytes` });
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return json(422, { error: "body must be JSON" }); }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) return json(422, { error: `invalid body: ${parsed.error.issues.slice(0, 3).map((i) => i.path.join(".") + " " + i.message).join("; ")}` });
    const b = parsed.data;

    const agentId = await (deps.resolveAgentId ?? defaultAgentId)(persona);
    if (!agentId) return json(409, { error: `persona '${persona}' is not live or has no Slack user id` });
    const agentSource = agentSourceForPersona(agentId);

    const mapErr = b.map ? validateMap(b.map, agentSource) : null;
    if (mapErr) return json(422, { error: mapErr });
    const targets: string[] = [];
    for (const p of b.pages) {
      const r = remapSource(p.source, { agentSource, map: b.map });
      if (!r.ok) {
        const why = r.code === "kb_out_of_scope" ? "kb-* sources are out of scope (re-created from the manifest)" : r.code === "no_mapping" ? "has no mapping (use map)" : "maps to a forbidden target";
        return json(422, { error: `source '${r.source}' ${why}` });
      }
      targets.push(r.target);
    }

    const engine = await (deps.engine ?? (getBrain as unknown as () => Promise<MigrateEngine>))();

    // A bundle with no vectors has nothing to be incompatible with.
    if (b.pages.some((p) => p.chunks.some((c) => c.embedding !== null))) {
      const target = await (deps.brainConfig ? deps.brainConfig() : defaultBrainConfig(engine));
      const bad = embeddingMismatch(b.engine, target);
      if (bad) return json(409, { error: bad });
    }

    const ensure = deps.ensureSource ?? ensureBrainSource;
    const onConflict: OnConflict = b.onConflict ?? "skip";
    const dryRun = b.dryRun ?? false;
    const sources: Record<string, SourceCounts> = {};
    const failedSlugs: string[] = [];
    const failedReasons: Record<string, number> = {};
    for (let i = 0; i < b.pages.length; i++) {
      const p = b.pages[i] as BundlePage;
      const t = targets[i]!;
      const linkTargets = p.links.map((l) => {
        const lr = remapSource(l.toSource, { agentSource, map: b.map });
        return { ...l, toSource: lr.ok ? lr.target : l.toSource };
      });
      const r = await applyPage(engine, { page: p, target: t, linkTargets }, { onConflict, dryRun, ensureSource: ensure });
      const s = (sources[t] ??= { written: 0, skipped: 0, overwritten: 0, failed: 0, linksWritten: 0, linksDropped: 0, linksFailed: 0, noEmbedding: 0 });
      s[r.outcome]++; s.linksWritten += r.linksWritten; s.linksDropped += r.linksDropped; s.linksFailed += r.linksFailed; s.noEmbedding += r.noEmbedding;
      if (r.outcome === "failed") {
        // Slugs of a person's slice are that person's content; only non-user slices list them.
        if (!t.startsWith("user-")) failedSlugs.push(p.slug);
        const why = r.reason === "error" ? `error:${r.errorName ?? "unknown"}` : (r.reason ?? "unknown");
        failedReasons[why] = (failedReasons[why] ?? 0) + 1;
      }
    }
    const counts = Object.entries(sources).map(([k, v]) => `${k}:w${v.written}/s${v.skipped}/o${v.overwritten}/f${v.failed}`).join(",");
    log(`[brain-import] persona=${persona} dryRun=${dryRun} onConflict=${onConflict} ${counts}`);
    return json(200, { persona, agentSource, dryRun, sources, failedSlugs, failedReasons });
  }
  return { fetch };
}
