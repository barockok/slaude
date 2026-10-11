# Brain migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Copy a single-agent (mono, embedded PGLite) brain's memory slices into the gateway's brain under a named persona's own agent slice, and prove with an end-to-end test that an agent that learned things in mono mode still recalls them after the move.

**Architecture:** `brain-export` reads a copy of the old PGLite brain through the gbrain engine into a checksummed bundle (`manifest.json` plus streamed `pages.jsonl`). `brain-import` verifies the bundle and posts batches to a token-guarded gateway route, which remaps agent-like source ids to the persona's `agent-<id>` slice and writes each page whole (page, chunks with carried embeddings, tags, timeline with original dates, raw data, links) inside one engine transaction. The gateway stays the only brain writer.

**Tech Stack:** Bun, TypeScript, `bun:test`, gbrain engine (PGLite and Postgres), existing `createDeployApi`-style fetch handlers.

**Spec:** `docs/superpowers/specs/2026-10-07-brain-migration-design.md`

## Global Constraints

- Public repo: generic placeholders only (`Jane Doe`, `UTESTUSER1`, `bulk-corpus`); no real people, orgs, hosts, Slack IDs. Run the leak scan from `CLAUDE.md` before every commit.
- No AI co-author trailers. Granular commits, one logical change each.
- No release, tag or version bump. This ships as a normal minor release (not an RC); nothing here edits `package.json` `version`.
- Memory slices only: `kb-*` sources are never exported by default and are refused (422) by the endpoint.
- The gateway is the only writer: the CLIs never receive `SLAUDE_BRAIN_DATABASE_URL`, `SLAUDE_JOB_SECRET` or any gateway-only variable.
- `SLAUDE_BRAIN_IMPORT_TOKEN`: unset means every path and method of `/brain-import/*` answers 404 before anything else is read; constant-time compare; added to `GATEWAY_ONLY_ENV_NAMES`; never a CLI flag.
- Endpoint limits: body capped at 4 MiB, at most 100 pages per request. Client batches at most 100 pages or 1 MB.
- Refusals are fixed messages that name the cause and never echo page text, titles or slugs of user slices. Audit line carries persona, per-source counts, `dryRun`, `onConflict` only.
- Slice ids are produced by the existing `agentSourceId` / `userSourceId` helpers (`src/knowledge/scope.ts`): lowercase, `[a-z0-9-]` only, dashes dropped from the id part, truncated to 32 chars. The spec writes `agent-<slackUserId>`; the code must use `agentSourceId(slackUserId)` so the target equals the slice the gateway's own memory plane reads.
- Embedding model and dimensions of bundle and target must match when the bundle carries embeddings; mismatch is refused (409), never re-embedded.
- Remote brain mode (`SLAUDE_BRAIN_MODE=remote`) and a disabled brain are refused (409).

## Review Focus

Failure modes the spec implies that no task would otherwise exercise; each has a pinning test in the named task.

1. **Slice id sanitising:** a Slack id such as `UANA-1x` must land in the same slice the persona's memory plane reads (`agentSourceId`), not a literal `agent-UANA-1x`. Task 1 (remap) and Task 7 (scenario reads through `agentScope`/`memoryScopeFor`).
2. **Default persona:** persona name `default` has no registry row; its agent id is the process agent id (`agentIdReady()`), exactly as `brainGateFor` does. Task 5.
3. **Two bundle sources onto one target** (`agent` legacy plus `agent-default`) with a slug in both: no crash, follows `onConflict`. Task 4.
4. **Partial page failure** (a tag insert throws mid-page): nothing of that page remains, batch continues, slug reported. Task 4.
5. **Empty brain / zero-page bundle, and a page with no chunks or no embeddings:** export and import succeed with zero counts; embeddings absent skips the model check. Tasks 2, 3, 5.
6. **Truncated or hand-edited `pages.jsonl`:** checksum fails before any request is sent. Task 2 and Task 6.
7. **Re-run after a crash:** `skip` finishes the rest and writes nothing twice. Task 7.
8. **A user slice must not leak:** `user-<id>` pages stay under their own id and are invisible to a scope without it, after migration too. Task 7.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/brain-migrate/remap.ts` | Pure: source mapping table, `map` override validation. |
| `src/brain-migrate/bundle.ts` | Bundle types, streaming writer/reader, sha256, batching. |
| `src/brain-migrate/export.ts` | Read a copy of a PGLite brain into a bundle (gbrain engine, read-only). |
| `src/brain-migrate/apply.ts` | Write one remapped page to an engine inside a transaction; conflict policy. |
| `src/brain-migrate/engine-types.ts` | Minimal structural types over the gbrain engine surface used here. |
| `src/gateway/brain-import/api.ts` | `createBrainImportApi`: route, auth, refusals, batch loop, audit line. |
| `src/cli/brain-export.ts` | CLI wrapper for `exportBrain`. |
| `src/cli/brain-import.ts` | CLI client: verify, batch, retry, count reconciliation. |
| `src/config/gateway-only-env.ts` | Add `SLAUDE_BRAIN_IMPORT_TOKEN`. |
| `src/config/env.ts` | `brainImportToken()` accessor. |
| `src/gateway/core/gateway.ts` | Mount the new api beside `deployApi`. |
| `tests/brain-migrate/*.test.ts` | Unit and integration tests (listed per task). |
| `tests/gateway/brain-import/*.test.ts` | Endpoint tests. |
| `docs/site/_content/deploy/brain-migration.md` | Operator runbook. |

---

### Task 1: Source remapping (pure)

**Files:**
- Create: `src/brain-migrate/remap.ts`
- Test: `tests/brain-migrate/remap.test.ts`

**Interfaces:**
- Consumes: `agentSourceId`, `userSourceId` from `src/knowledge/scope.ts`.
- Produces:
  ```ts
  export type RemapResult =
    | { ok: true; target: string }
    | { ok: false; code: "kb_out_of_scope" | "no_mapping" | "forbidden_target"; source: string };
  export interface RemapOptions { agentSource: string; map?: Record<string, string> }
  export function agentSourceForPersona(agentId: string): string;
  export function isAgentLike(source: string): boolean;
  export function remapSource(source: string, o: RemapOptions): RemapResult;
  export function validateMap(map: Record<string, string>, agentSource: string): string | null; // error text or null
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/brain-migrate/remap.test.ts
import { describe, expect, test } from "bun:test";
import { agentSourceForPersona, isAgentLike, remapSource, validateMap } from "../../src/brain-migrate/remap";

const AGENT = agentSourceForPersona("UTESTUSER1"); // agent-utestuser1

describe("remapSource", () => {
  test("agent-like sources go to the persona's agent slice", () => {
    for (const s of ["agent", "agent-default", "agent-u0old"]) {
      expect(remapSource(s, { agentSource: AGENT })).toEqual({ ok: true, target: AGENT });
    }
  });
  test("target equals the slice the gateway reads (sanitised id)", () => {
    expect(agentSourceForPersona("UANA-1x")).toBe("agent-uana1x");
  });
  test("user, shared and public are unchanged", () => {
    for (const s of ["user-ualice", "shared", "public"]) {
      expect(remapSource(s, { agentSource: AGENT })).toEqual({ ok: true, target: s });
    }
  });
  test("kb-* is out of scope, anything else has no mapping", () => {
    expect(remapSource("kb-bulk-corpus", { agentSource: AGENT })).toEqual({ ok: false, code: "kb_out_of_scope", source: "kb-bulk-corpus" });
    expect(remapSource("scratch", { agentSource: AGENT })).toEqual({ ok: false, code: "no_mapping", source: "scratch" });
  });
  test("a map entry wins over the table for the source it names", () => {
    expect(remapSource("scratch", { agentSource: AGENT, map: { scratch: "shared" } })).toEqual({ ok: true, target: "shared" });
    expect(remapSource("shared", { agentSource: AGENT, map: { shared: "public" } })).toEqual({ ok: true, target: "public" });
  });
  test("a map into kb-* or another persona's agent slice is forbidden", () => {
    expect(remapSource("scratch", { agentSource: AGENT, map: { scratch: "kb-x" } })).toMatchObject({ ok: false, code: "forbidden_target" });
    expect(remapSource("scratch", { agentSource: AGENT, map: { scratch: "agent-uother" } })).toMatchObject({ ok: false, code: "forbidden_target" });
  });
});

describe("validateMap / isAgentLike", () => {
  test("validateMap names the bad entry and never anything else", () => {
    expect(validateMap({ a: "shared" }, AGENT)).toBeNull();
    expect(validateMap({ a: "kb-x" }, AGENT)).toMatch(/kb-x/);
    expect(validateMap({ a: "agent-uother" }, AGENT)).toMatch(/agent-uother/);
  });
  test("isAgentLike", () => {
    expect(isAgentLike("agent")).toBe(true);
    expect(isAgentLike("agent-x")).toBe(true);
    expect(isAgentLike("agents")).toBe(false);
    expect(isAgentLike("user-agent")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/brain-migrate/remap.test.ts`
Expected: FAIL, "Cannot find module .../remap".

- [ ] **Step 3: Implement**

```ts
// src/brain-migrate/remap.ts
import { agentSourceId } from "../knowledge/scope";

export type RemapResult =
  | { ok: true; target: string }
  | { ok: false; code: "kb_out_of_scope" | "no_mapping" | "forbidden_target"; source: string };

export interface RemapOptions {
  /** The persona's own agent slice (agentSourceForPersona of its Slack user id). */
  agentSource: string;
  map?: Record<string, string>;
}

/** The slice the gateway itself reads for this identity (never a hand-built `agent-<id>`). */
export function agentSourceForPersona(agentId: string): string {
  return agentSourceId(agentId);
}

export const isAgentLike = (s: string): boolean => s === "agent" || s.startsWith("agent-");
const isUser = (s: string): boolean => /^user-[a-z0-9]+$/.test(s);
const isKb = (s: string): boolean => s.startsWith("kb-");

/** A target a `map` entry may point at: the persona's slice, a user slice, shared, public. */
function allowedTarget(t: string, agentSource: string): boolean {
  return t === agentSource || t === "shared" || t === "public" || isUser(t);
}

export function validateMap(map: Record<string, string>, agentSource: string): string | null {
  for (const [from, to] of Object.entries(map)) {
    if (!allowedTarget(to, agentSource)) return `map target '${to}' (from '${from}') is not the persona's agent slice, a user slice, shared or public`;
  }
  return null;
}

export function remapSource(source: string, o: RemapOptions): RemapResult {
  const mapped = o.map?.[source];
  if (mapped !== undefined) {
    return allowedTarget(mapped, o.agentSource)
      ? { ok: true, target: mapped }
      : { ok: false, code: "forbidden_target", source };
  }
  if (isKb(source)) return { ok: false, code: "kb_out_of_scope", source };
  if (isAgentLike(source)) return { ok: true, target: o.agentSource };
  if (source === "shared" || source === "public" || isUser(source)) return { ok: true, target: source };
  return { ok: false, code: "no_mapping", source };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/brain-migrate/remap.test.ts && bun run typecheck`
Expected: PASS, typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/brain-migrate/remap.ts tests/brain-migrate/remap.test.ts
git commit -m "feat(brain-migrate): source remapping table with map overrides"
```

---

### Task 2: Bundle format (write, verify, read, batch)

**Files:**
- Create: `src/brain-migrate/bundle.ts`
- Test: `tests/brain-migrate/bundle.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export const BUNDLE_VERSION = 1;
  export interface BundleChunk { index: number; text: string; source: "compiled_truth" | "timeline" | "fenced_code"; embedding: number[] | null; model: string | null; tokens: number | null }
  export interface BundlePage {
    source: string; slug: string; type: string; title: string; compiledTruth: string; timeline: string;
    frontmatter: Record<string, unknown>; contentHash: string | null;
    chunks: BundleChunk[]; tags: string[];
    timelineEntries: Array<{ date: string; source: string; summary: string; detail: string }>;
    raw: Array<{ source: string; data: Record<string, unknown> }>;
    links: Array<{ toSource: string; toSlug: string; type: string; context: string }>;
  }
  export interface BundleEngineInfo { schemaVersion: number | null; embeddingModel: string | null; embeddingDimensions: number | null }
  export interface BundleManifest {
    version: number; createdAt: string; engine: BundleEngineInfo;
    sources: Array<{ id: string; pages: number; chunks: number; embedded: number }>;
    files: { "pages.jsonl": string }; excluded: string[];
  }
  export class BundleWriter {
    constructor(dir: string);
    writePage(p: BundlePage): Promise<void>;
    finish(meta: { engine: BundleEngineInfo; excluded: string[] }): Promise<BundleManifest>; // computes sources inventory from written pages
  }
  export function readManifest(dir: string): BundleManifest;           // throws on missing/invalid
  export function verifyBundle(dir: string): Promise<BundleManifest>;  // + sha256 of pages.jsonl
  export function readPages(dir: string): AsyncGenerator<BundlePage>;
  export function batchPages(pages: AsyncIterable<BundlePage>, maxPages?: number, maxBytes?: number): AsyncGenerator<BundlePage[]>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/brain-migrate/bundle.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLE_VERSION, BundleWriter, batchPages, readManifest, readPages, verifyBundle, type BundlePage } from "../../src/brain-migrate/bundle";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "bundle-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const page = (slug: string, source = "agent-default", withEmb = true): BundlePage => ({
  source, slug, type: "note", title: slug, compiledTruth: `truth ${slug}`, timeline: "",
  frontmatter: { k: 1 }, contentHash: "h-" + slug,
  chunks: [{ index: 0, text: `truth ${slug}`, source: "compiled_truth", embedding: withEmb ? [0.5, -0.25, 0] : null, model: withEmb ? "m" : null, tokens: 3 }],
  tags: ["t1"], timelineEntries: [{ date: "2025-01-02", source: "s", summary: "did", detail: "" }],
  raw: [], links: [],
});
const meta = { engine: { schemaVersion: 1, embeddingModel: "m", embeddingDimensions: 3 }, excluded: ["kb-*"] };

describe("bundle", () => {
  test("round trip preserves pages and builds the inventory", async () => {
    const d = tmp();
    const w = new BundleWriter(d);
    await w.writePage(page("a")); await w.writePage(page("b", "shared", false));
    const m = await w.finish(meta);
    expect(m.version).toBe(BUNDLE_VERSION);
    expect(m.sources).toEqual([
      { id: "agent-default", pages: 1, chunks: 1, embedded: 1 },
      { id: "shared", pages: 1, chunks: 1, embedded: 0 },
    ]);
    const back: BundlePage[] = [];
    for await (const p of readPages(d)) back.push(p);
    expect(back.map((p) => p.slug)).toEqual(["a", "b"]);
    expect(back[0]!.chunks[0]!.embedding).toEqual([0.5, -0.25, 0]);
    expect((await verifyBundle(d)).files["pages.jsonl"]).toBe(m.files["pages.jsonl"]);
  });
  test("an empty bundle is valid", async () => {
    const d = tmp();
    const m = await new BundleWriter(d).finish(meta);
    expect(m.sources).toEqual([]);
    expect((await verifyBundle(d)).sources).toEqual([]);
  });
  test("no manifest (interrupted export) is refused", async () => {
    const d = tmp();
    const w = new BundleWriter(d); await w.writePage(page("a"));
    expect(() => readManifest(d)).toThrow(/manifest/i);
  });
  test("a flipped byte and an appended line both fail the checksum", async () => {
    const d = tmp();
    const w = new BundleWriter(d); await w.writePage(page("a")); await w.finish(meta);
    const f = join(d, "pages.jsonl");
    const orig = readFileSync(f, "utf8");
    writeFileSync(f, orig.replace("truth a", "truth X"));
    await expect(verifyBundle(d)).rejects.toThrow(/checksum/i);
    writeFileSync(f, orig); appendFileSync(f, "{}\n");
    await expect(verifyBundle(d)).rejects.toThrow(/checksum/i);
  });
  test("manifest without files or with a future version is refused", async () => {
    const d = tmp();
    const w = new BundleWriter(d); await w.writePage(page("a")); const m = await w.finish(meta);
    writeFileSync(join(d, "manifest.json"), JSON.stringify({ ...m, files: undefined }));
    expect(() => readManifest(d)).toThrow(/files/);
    writeFileSync(join(d, "manifest.json"), JSON.stringify({ ...m, version: 99 }));
    expect(() => readManifest(d)).toThrow(/version/);
  });
  test("batchPages cuts on page count and on bytes", async () => {
    async function* gen(n: number) { for (let i = 0; i < n; i++) yield page("p" + i); }
    const sizes: number[] = [];
    for await (const b of batchPages(gen(5), 2)) sizes.push(b.length);
    expect(sizes).toEqual([2, 2, 1]);
    const byBytes: number[] = [];
    for await (const b of batchPages(gen(4), 100, JSON.stringify(page("p0")).length + 10)) byBytes.push(b.length);
    expect(byBytes).toEqual([1, 1, 1, 1]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/brain-migrate/bundle.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/brain-migrate/bundle.ts
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const BUNDLE_VERSION = 1;

export interface BundleChunk { index: number; text: string; source: "compiled_truth" | "timeline" | "fenced_code"; embedding: number[] | null; model: string | null; tokens: number | null }
export interface BundlePage {
  source: string; slug: string; type: string; title: string; compiledTruth: string; timeline: string;
  frontmatter: Record<string, unknown>; contentHash: string | null;
  chunks: BundleChunk[]; tags: string[];
  timelineEntries: Array<{ date: string; source: string; summary: string; detail: string }>;
  raw: Array<{ source: string; data: Record<string, unknown> }>;
  links: Array<{ toSource: string; toSlug: string; type: string; context: string }>;
}
export interface BundleEngineInfo { schemaVersion: number | null; embeddingModel: string | null; embeddingDimensions: number | null }
export interface BundleManifest {
  version: number; createdAt: string; engine: BundleEngineInfo;
  sources: Array<{ id: string; pages: number; chunks: number; embedded: number }>;
  files: { "pages.jsonl": string }; excluded: string[];
}

export class BundleWriter {
  private out: WriteStream;
  private hash = createHash("sha256");
  private inv = new Map<string, { pages: number; chunks: number; embedded: number }>();

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
    this.out = createWriteStream(join(dir, "pages.jsonl"), { flags: "w" });
  }

  async writePage(p: BundlePage): Promise<void> {
    const line = JSON.stringify(p) + "\n";
    this.hash.update(line);
    const s = this.inv.get(p.source) ?? { pages: 0, chunks: 0, embedded: 0 };
    s.pages++; s.chunks += p.chunks.length; s.embedded += p.chunks.filter((c) => c.embedding !== null).length;
    this.inv.set(p.source, s);
    if (!this.out.write(line)) await new Promise<void>((r) => this.out.once("drain", () => r()));
  }

  /** Closes pages.jsonl, then writes the manifest LAST (no manifest = interrupted export). */
  async finish(meta: { engine: BundleEngineInfo; excluded: string[] }): Promise<BundleManifest> {
    await new Promise<void>((res, rej) => { this.out.once("error", rej); this.out.end(() => res()); });
    const manifest: BundleManifest = {
      version: BUNDLE_VERSION,
      createdAt: new Date().toISOString(),
      engine: meta.engine,
      sources: [...this.inv.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, s]) => ({ id, ...s })),
      files: { "pages.jsonl": this.hash.digest("hex") },
      excluded: meta.excluded,
    };
    writeFileSync(join(this.dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    return manifest;
  }
}

export function readManifest(dir: string): BundleManifest {
  const f = join(dir, "manifest.json");
  if (!existsSync(f)) throw new Error("bundle has no manifest.json (interrupted export?)");
  const m = JSON.parse(readFileSync(f, "utf8")) as Partial<BundleManifest>;
  if (m.version !== BUNDLE_VERSION) throw new Error(`unsupported bundle version ${String(m.version)} (want ${BUNDLE_VERSION})`);
  if (!m.files || typeof m.files["pages.jsonl"] !== "string") throw new Error("manifest has no files checksum");
  if (!m.engine || !Array.isArray(m.sources)) throw new Error("manifest is missing engine or sources");
  return m as BundleManifest;
}

export async function verifyBundle(dir: string): Promise<BundleManifest> {
  const m = readManifest(dir);
  const h = createHash("sha256");
  await new Promise<void>((res, rej) => {
    createReadStream(join(dir, "pages.jsonl")).on("data", (c) => h.update(c)).on("end", () => res()).on("error", rej);
  });
  if (h.digest("hex") !== m.files["pages.jsonl"]) throw new Error("pages.jsonl checksum does not match the manifest");
  return m;
}

export async function* readPages(dir: string): AsyncGenerator<BundlePage> {
  const rl = createInterface({ input: createReadStream(join(dir, "pages.jsonl"), { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) yield JSON.parse(line) as BundlePage;
}

export async function* batchPages(pages: AsyncIterable<BundlePage>, maxPages = 100, maxBytes = 1_000_000): AsyncGenerator<BundlePage[]> {
  let batch: BundlePage[] = [];
  let bytes = 0;
  for await (const p of pages) {
    const size = JSON.stringify(p).length;
    if (batch.length > 0 && (batch.length >= maxPages || bytes + size > maxBytes)) {
      yield batch; batch = []; bytes = 0;
    }
    batch.push(p); bytes += size;
  }
  if (batch.length) yield batch;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/brain-migrate/bundle.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/brain-migrate/bundle.ts tests/brain-migrate/bundle.test.ts
git commit -m "feat(brain-migrate): checksummed streaming bundle format"
```

---

### Task 3: Export (read a copy of a PGLite brain) and the CLI

**Files:**
- Create: `src/brain-migrate/engine-types.ts`, `src/brain-migrate/export.ts`, `src/cli/brain-export.ts`
- Test: `tests/brain-migrate/export.test.ts`
- Modify: `package.json` (scripts: `"brain-export": "bun src/cli/brain-export.ts"`, `"brain-import": "bun src/cli/brain-import.ts"`)

**Interfaces:**
- Consumes: `BundleWriter`, `BundlePage` (Task 2); `brainCall`, `closeBrain`, `ensureSources`, `getBrain` (`src/knowledge/brain.ts`) for seeding in tests only.
- Produces:
  ```ts
  // engine-types.ts: the slice of the gbrain engine this feature touches
  export interface MigrateEngine {
    connect(c: object): Promise<void>; disconnect(): Promise<void>; initSchema(): Promise<void>;
    transaction<T>(fn: (tx: MigrateEngine) => Promise<T>): Promise<T>;
    listPages(f: { sourceId?: string; limit?: number; offset?: number; sort?: "slug"; includeDeleted?: boolean }): Promise<Array<{ slug: string; type: string; title: string; compiled_truth: string; timeline: string; frontmatter: Record<string, unknown>; content_hash?: string; source_id: string }>>;
    getPage(slug: string, o?: { sourceId?: string; includeDeleted?: boolean }): Promise<{ slug: string } | null>;
    getChunksWithEmbeddings(slug: string, o?: { sourceId?: string }): Promise<Array<{ chunk_index: number; chunk_text: string; chunk_source: "compiled_truth" | "timeline" | "fenced_code"; embedding: Float32Array | null; model: string; token_count: number | null }>>;
    getTags(slug: string, o?: { sourceId?: string }): Promise<string[]>;
    getTimeline(slug: string, o?: { sourceId?: string; limit?: number }): Promise<Array<{ date: string; source: string; summary: string; detail: string }>>;
    getRawData(slug: string, source?: string, o?: { sourceId?: string }): Promise<Array<{ source: string; data: Record<string, unknown> }>>;
    putPage(slug: string, p: { type: string; title: string; compiled_truth: string; timeline?: string; frontmatter?: Record<string, unknown>; content_hash?: string }, o?: { sourceId?: string }): Promise<unknown>;
    upsertChunks(slug: string, chunks: Array<{ chunk_index: number; chunk_text: string; chunk_source: "compiled_truth" | "timeline" | "fenced_code"; embedding?: Float32Array; model?: string; token_count?: number }>, o?: { sourceId?: string }): Promise<void>;
    addTag(slug: string, tag: string, o?: { sourceId?: string }): Promise<void>;
    addTimelineEntry(slug: string, e: { date: string; source?: string; summary: string; detail?: string }, o?: { sourceId?: string; skipExistenceCheck?: boolean }): Promise<void>;
    putRawData(slug: string, source: string, data: object, o?: { sourceId?: string }): Promise<void>;
    addLink(from: string, to: string, context?: string, linkType?: string, linkSource?: string, originSlug?: string, originField?: string, o?: { fromSourceId?: string; toSourceId?: string }): Promise<void>;
    db: { query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };
  }
  // export.ts
  export interface ExportOptions { home: string; out: string; include?: string[]; exclude?: string[] }
  export interface ExportResult { manifest: BundleManifest; copied: string }
  export function exportBrain(o: ExportOptions): Promise<ExportResult>;
  export function selectSources(all: string[], include: string[] | undefined, exclude: string[] | undefined): { keep: string[]; excluded: string[] };
  ```

Facts verified in `node_modules/gbrain/src/core/pglite-engine.ts`: `transaction`, `listPages` (`sourceId`, `sort: 'slug'`, `limit`, `offset`, `includeDeleted`), `getChunksWithEmbeddings`, `getTags`, `getTimeline`, `getRawData`, `putPage`, `upsertChunks`, `addTag`, `addTimelineEntry`, `putRawData`, `addLink` all take `sourceId`. `Link` rows carry no target source, so export reads links with SQL over `links`/`pages`. Sources list: `SELECT id FROM sources ORDER BY id`.

- [ ] **Step 1: Spike the seeding facts (no commit)**

Write a scratch script under the scratchpad directory (not the repo) that sets `SLAUDE_BRAIN_HOME` to a temp dir, calls `getBrain()`, and prints (a) the engine's vector dimension (`SELECT atttypmod FROM pg_attribute ... embedding` or insert a `Float32Array(1536)`), (b) whether `upsertChunks` accepts an explicit embedding while no embedding provider is configured, (c) that `engine.db.query("SELECT id FROM sources")` works. Record the dimension as `TEST_DIMS` for the tests below. If explicit embeddings are rejected without provider config, write `{ "embedding_model": "litellm:test-embed", "embedding_dimensions": 8 }` into `<home>/config.json` before the first `getBrain()` and re-test; keep whichever makes (b) true and use that in the tests' `seedBrain` helper.

- [ ] **Step 2: Write the failing test**

```ts
// tests/brain-migrate/export.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedMonoBrain, TEST_DIMS } from "./seed";

const root = mkdtempSync(join(tmpdir(), "bm-export-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

import { exportBrain, selectSources } from "../../src/brain-migrate/export";
import { readManifest, readPages, verifyBundle, type BundlePage } from "../../src/brain-migrate/bundle";

describe("selectSources", () => {
  test("default drops kb-*; include and exclude override by id or kb- prefix", () => {
    const all = ["agent-default", "shared", "public", "kb-a", "user-u1"];
    expect(selectSources(all, undefined, undefined)).toEqual({ keep: ["agent-default", "shared", "public", "user-u1"], excluded: ["kb-a"] });
    expect(selectSources(all, ["shared"], undefined).keep).toEqual(["shared"]);
    expect(selectSources(all, undefined, ["public", "kb-"]).keep).toEqual(["agent-default", "shared", "user-u1"]);
  });
});

describe("exportBrain", () => {
  test("exports a mono brain without touching the original", async () => {
    const home = join(root, "mono");
    await seedMonoBrain(home);
    const out = join(root, "bundle");
    const { manifest } = await exportBrain({ home, out });
    expect(manifest.sources.map((s) => s.id).sort()).toEqual(["agent-default", "public", "shared", "user-ualice"]);
    expect(manifest.excluded).toContain("kb-bulk-corpus");
    expect(manifest.engine.embeddingDimensions).toBe(TEST_DIMS);
    await verifyBundle(out);
    const pages: BundlePage[] = [];
    for await (const p of readPages(out)) pages.push(p);
    const mem = pages.find((p) => p.source === "agent-default" && p.slug.startsWith("conversations/"))!;
    expect(mem.compiledTruth).toContain("deploy cadence");
    const emb = pages.find((p) => p.chunks.some((c) => c.embedding))!;
    expect(emb.chunks.find((c) => c.embedding)!.embedding!.length).toBe(TEST_DIMS);
    const withTimeline = pages.find((p) => p.timelineEntries.length)!;
    expect(withTimeline.timelineEntries[0]!.date).toBe("2024-03-05"); // original date, not today
    expect(pages.some((p) => p.tags.includes("ops"))).toBe(true);
    expect(pages.some((p) => p.links.length > 0)).toBe(true);
    expect(pages.every((p) => !p.source.startsWith("kb-"))).toBe(true);
    // original brain dir still opens (no lock taken, nothing deleted)
    expect(existsSync(join(home, "db"))).toBe(true);
  }, 120_000);

  test("an empty brain exports a valid zero-page bundle", async () => {
    const home = join(root, "empty");
    await seedMonoBrain(home, { empty: true });
    const out = join(root, "empty-bundle");
    const { manifest } = await exportBrain({ home, out });
    expect(manifest.sources).toEqual([]);
    expect(readManifest(out).files["pages.jsonl"]).toMatch(/^[0-9a-f]{64}$/);
  }, 120_000);

  test("a missing home is a clear error", async () => {
    await expect(exportBrain({ home: join(root, "nope"), out: join(root, "x") })).rejects.toThrow(/brain home/i);
  });
});
```

Also create the shared seeding helper, used again by Tasks 4 and 7:

```ts
// tests/brain-migrate/seed.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Dimension the test brains use (set from the Step 1 spike; 1536 if the default schema accepts explicit vectors). */
export const TEST_DIMS = 1536;
export const vec = (seed: number): number[] => Array.from({ length: TEST_DIMS }, (_, i) => Math.sin(seed + i) / 10);

/**
 * Build a MONO-mode brain at `home`: a default persona with no SLAUDE_AGENT_ID,
 * so its private mind is `agent-default` (what a single-agent deployment has).
 * Contents: conversation memory via BrainMemoryProvider, a person's slice,
 * shared/public pages with tags, a dated timeline entry, a link, embeddings,
 * and a kb-* page that must not travel.
 * Runs in the current process against SLAUDE_BRAIN_HOME=home, then closes the brain.
 */
export async function seedMonoBrain(home: string, o: { empty?: boolean } = {}): Promise<void> {
  mkdirSync(home, { recursive: true });
  process.env.SLAUDE_BRAIN_HOME = home;
  delete process.env.SLAUDE_AGENT_ID;
  const { closeBrain, getBrain, ensureSource } = await import("../../src/knowledge/brain");
  const { resetAgentId } = await import("../../src/knowledge/agent-identity");
  resetAgentId();
  try {
    const engine = (await getBrain()) as unknown as import("../../src/brain-migrate/engine-types").MigrateEngine;
    if (o.empty) return;
    const { BrainMemoryProvider } = await import("../../src/memory/brain-provider");
    const mem = new BrainMemoryProvider();
    const session = "11111111-2222-3333-4444-555555555555";
    await mem.syncTurn({ sessionId: session, user: "what is the deploy cadence?", assistant: "weekly, thursdays" });
    await mem.syncTurn({ sessionId: session, user: "and the oncall?", assistant: "rotates monday" });
    for (const s of ["agent-default", "shared", "public", "user-ualice", "kb-bulk-corpus"]) await ensureSource(s);
    const put = async (source: string, slug: string, truth: string, extra: Partial<{ tags: string[]; seed: number }> = {}) => {
      await engine.putPage(slug, { type: "note", title: slug, compiled_truth: truth }, { sourceId: source });
      await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: truth, chunk_source: "compiled_truth", embedding: Float32Array.from(vec(extra.seed ?? 1)), model: "test-embed", token_count: 4 }], { sourceId: source });
      for (const t of extra.tags ?? []) await engine.addTag(slug, t, { sourceId: source });
    };
    await put("agent-default", "learned/runbook", "Restart the worker with the zebra procedure.", { tags: ["ops"], seed: 2 });
    await engine.addTimelineEntry("learned/runbook", { date: "2024-03-05", source: "ops", summary: "wrote runbook" }, { sourceId: "agent-default" });
    await put("agent-default", "learned/index", "Index of runbooks. See [[learned/runbook]].", { seed: 3 });
    await engine.addLink("learned/index", "learned/runbook", "see", "references", "manual", undefined, undefined, { fromSourceId: "agent-default", toSourceId: "agent-default" });
    await engine.putRawData("learned/runbook", "ops-import", { k: "v" }, { sourceId: "agent-default" });
    await put("user-ualice", "people/alice", "Alice prefers quokka-themed standups.", { seed: 4 });
    await put("shared", "team/norms", "Team norm: narwhal reviews on Fridays.", { seed: 5 });
    await put("public", "faq/hours", "Public FAQ: pelican support hours.", { seed: 6 });
    await put("kb-bulk-corpus", "kb/page", "Bulk corpus page that must not travel.", { seed: 7 });
  } finally {
    await closeBrain();
  }
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun test tests/brain-migrate/export.test.ts`
Expected: FAIL, module `export` not found.

- [ ] **Step 4: Implement `engine-types.ts` (types from the Interfaces block above), `export.ts` and the CLI**

```ts
// src/brain-migrate/export.ts
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleWriter, type BundleManifest, type BundlePage } from "./bundle";
import type { MigrateEngine } from "./engine-types";

const gbrainImport = (subpath: string): Promise<Record<string, unknown>> =>
  import(("gbrain/" + subpath) as string) as Promise<Record<string, unknown>>;

export interface ExportOptions { home: string; out: string; include?: string[]; exclude?: string[] }
export interface ExportResult { manifest: BundleManifest; copied: string }

const matches = (id: string, pat: string): boolean => (pat === "kb-" ? id.startsWith("kb-") : id === pat);

export function selectSources(all: string[], include: string[] | undefined, exclude: string[] | undefined): { keep: string[]; excluded: string[] } {
  const keep: string[] = [];
  const excluded: string[] = [];
  for (const id of all) {
    const dropped = include && include.length
      ? !include.some((p) => matches(id, p))
      : id.startsWith("kb-") || (exclude ?? []).some((p) => matches(id, p));
    const explicitExclude = (exclude ?? []).some((p) => matches(id, p));
    (dropped || explicitExclude ? excluded : keep).push(id);
  }
  return { keep, excluded };
}

function readBrainConfig(home: string): { embedding_model?: string; embedding_dimensions?: number } {
  try { return JSON.parse(readFileSync(join(home, "config.json"), "utf8")); } catch { return {}; }
}

/**
 * Reads a COPY of the brain directory through the gbrain engine. Never calls
 * slaude's getBrain() (it clears locks and runs schema writes) and never opens
 * the original, so a live brain is not locked and nothing in it changes.
 */
export async function exportBrain(o: ExportOptions): Promise<ExportResult> {
  if (!existsSync(join(o.home, "db"))) throw new Error(`brain home '${o.home}' has no db directory`);
  const copied = mkdtempSync(join(tmpdir(), "brain-export-"));
  cpSync(o.home, copied, { recursive: true });
  const cfg = { engine: "pglite", database_path: join(copied, "db") };
  const { createEngine } = (await gbrainImport("engine-factory")) as { createEngine: (c: object) => Promise<MigrateEngine> };
  const engine = await createEngine(cfg);
  try {
    await engine.connect(cfg);
    const ids = (await engine.db.query("SELECT id FROM sources ORDER BY id")).rows.map((r) => String(r.id));
    const { keep, excluded } = selectSources(ids, o.include, o.exclude);
    const w = new BundleWriter(o.out);
    for (const source of keep) {
      for (let offset = 0; ; offset += 200) {
        const batch = await engine.listPages({ sourceId: source, limit: 200, offset, sort: "slug" });
        if (batch.length === 0) break;
        for (const pg of batch) await w.writePage(await readPage(engine, source, pg));
      }
    }
    const bc = readBrainConfig(copied);
    const manifest = await w.finish({
      engine: { schemaVersion: null, embeddingModel: bc.embedding_model ?? null, embeddingDimensions: bc.embedding_dimensions ?? null },
      excluded,
    });
    return { manifest, copied };
  } finally {
    await engine.disconnect().catch(() => {});
    rmSync(copied, { recursive: true, force: true });
  }
}

async function readPage(engine: MigrateEngine, source: string, pg: Awaited<ReturnType<MigrateEngine["listPages"]>>[number]): Promise<BundlePage> {
  const so = { sourceId: source };
  const chunks = await engine.getChunksWithEmbeddings(pg.slug, so);
  const links = (await engine.db.query(
    `SELECT l.link_type, l.context, tp.slug AS to_slug, tp.source_id AS to_source
       FROM links l JOIN pages fp ON fp.id = l.from_page_id JOIN pages tp ON tp.id = l.to_page_id
      WHERE fp.slug = $1 AND fp.source_id = $2`, [pg.slug, source])).rows;
  return {
    source, slug: pg.slug, type: pg.type, title: pg.title, compiledTruth: pg.compiled_truth, timeline: pg.timeline,
    frontmatter: pg.frontmatter ?? {}, contentHash: pg.content_hash ?? null,
    chunks: chunks.map((c) => ({
      index: c.chunk_index, text: c.chunk_text, source: c.chunk_source,
      embedding: c.embedding ? Array.from(c.embedding) : null, model: c.embedding ? c.model : null, tokens: c.token_count,
    })),
    tags: await engine.getTags(pg.slug, so),
    timelineEntries: (await engine.getTimeline(pg.slug, { ...so, limit: 100000 })).map((t) => ({ date: t.date, source: t.source, summary: t.summary, detail: t.detail })),
    raw: (await engine.getRawData(pg.slug, undefined, so)).map((r) => ({ source: r.source, data: r.data })),
    links: links.map((l) => ({ toSource: String(l.to_source), toSlug: String(l.to_slug), type: String(l.link_type), context: String(l.context) })),
  };
}
```

Note: the `getTimeline` `date` may be a `Date` or a `YYYY-MM-DD` string depending on the engine; normalise with `typeof t.date === "string" ? t.date.slice(0, 10) : t.date.toISOString().slice(0, 10)` if the test shows a `Date`.

```ts
// src/cli/brain-export.ts
import { parseArgs } from "node:util";
import { exportBrain } from "../brain-migrate/export";

const { values } = parseArgs({
  options: { home: { type: "string" }, out: { type: "string" }, include: { type: "string", multiple: true }, exclude: { type: "string", multiple: true } },
});
if (!values.home || !values.out) {
  console.error("usage: brain-export --home <brain-dir> --out <bundle-dir> [--include <source>...] [--exclude <source>...]");
  process.exit(2);
}
const { manifest } = await exportBrain({ home: values.home, out: values.out, include: values.include, exclude: values.exclude });
console.log(`bundle written to ${values.out}`);
console.log("source inventory (agent-like sources are remapped on import):");
for (const s of manifest.sources) console.log(`  ${s.id.padEnd(34)} pages=${s.pages} chunks=${s.chunks} embedded=${s.embedded}`);
if (manifest.excluded.length) console.log(`excluded: ${manifest.excluded.join(", ")}`);
```

- [ ] **Step 5: Run to verify it passes**

Run: `bun test tests/brain-migrate/export.test.ts && bun run typecheck`
Expected: PASS. If the "original dir untouched" or timeline date assertion fails, fix the code, not the assertion.

- [ ] **Step 6: Commit**

```bash
git add src/brain-migrate/engine-types.ts src/brain-migrate/export.ts src/cli/brain-export.ts tests/brain-migrate/export.test.ts tests/brain-migrate/seed.ts package.json
git commit -m "feat(brain-migrate): brain-export reads a copy of a PGLite brain into a bundle"
```

---

### Task 4: Apply one page to an engine (conflict policy, transactional)

**Files:**
- Create: `src/brain-migrate/apply.ts`
- Test: `tests/brain-migrate/apply.test.ts`

**Interfaces:**
- Consumes: `MigrateEngine` (Task 3), `BundlePage` (Task 2).
- Produces:
  ```ts
  export type OnConflict = "skip" | "overwrite" | "fail";
  export type PageOutcome = "written" | "skipped" | "overwritten" | "failed";
  export interface ApplyPage { page: BundlePage; target: string; linkTargets: Array<{ toSource: string; toSlug: string; type: string; context: string }> }
  export function applyPage(engine: MigrateEngine, a: ApplyPage, o: { onConflict: OnConflict; dryRun: boolean; ensureSource: (id: string) => Promise<void> }): Promise<{ outcome: PageOutcome; linksWritten: number; linksDropped: number; noEmbedding: number }>;
  ```
  `linkTargets` is the page's links after the caller remapped `toSource` and dropped nothing; `applyPage` drops (and counts) a link whose target page does not exist in the engine at write time.

- [ ] **Step 1: Write the failing test**

```ts
// tests/brain-migrate/apply.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_DIMS, vec } from "./seed";

const home = mkdtempSync(join(tmpdir(), "bm-apply-"));
process.env.SLAUDE_BRAIN_HOME = home;
import { closeBrain, ensureSource, getBrain } from "../../src/knowledge/brain";
import { applyPage } from "../../src/brain-migrate/apply";
import type { MigrateEngine } from "../../src/brain-migrate/engine-types";
import type { BundlePage } from "../../src/brain-migrate/bundle";

let engine: MigrateEngine;
beforeAll(async () => { engine = (await getBrain()) as unknown as MigrateEngine; }, 60_000);
afterAll(async () => { await closeBrain(); rmSync(home, { recursive: true, force: true }); });

const mk = (slug: string, truth: string, over: Partial<BundlePage> = {}): BundlePage => ({
  source: "agent-default", slug, type: "note", title: slug, compiledTruth: truth, timeline: "", frontmatter: {}, contentHash: null,
  chunks: [{ index: 0, text: truth, source: "compiled_truth", embedding: vec(1), model: "test-embed", tokens: 3 }],
  tags: ["a"], timelineEntries: [{ date: "2024-03-05", source: "s", summary: "sum", detail: "" }],
  raw: [{ source: "r", data: { x: 1 } }], links: [], ...over,
});
const opts = (onConflict: "skip" | "overwrite" | "fail", dryRun = false) => ({ onConflict, dryRun, ensureSource });
const run = (p: BundlePage, target: string, o = opts("skip")) => applyPage(engine, { page: p, target, linkTargets: p.links }, o);

describe("applyPage", () => {
  test("writes page, chunks with embeddings, tags, original timeline date, raw data", async () => {
    const r = await run(mk("p1", "first body"), "agent-uone");
    expect(r.outcome).toBe("written");
    const so = { sourceId: "agent-uone" };
    expect((await engine.getPage("p1", so))!.slug).toBe("p1");
    const ch = await engine.getChunksWithEmbeddings("p1", so);
    expect(ch[0]!.embedding!.length).toBe(TEST_DIMS);
    expect(Array.from(ch[0]!.embedding!)[3]).toBeCloseTo(vec(1)[3]!, 5);
    expect(await engine.getTags("p1", so)).toEqual(["a"]);
    expect((await engine.getTimeline("p1", so))[0]!.date.toString().slice(0, 10)).toBe("2024-03-05");
    expect((await engine.getRawData("p1", undefined, so))[0]!.data).toEqual({ x: 1 });
  });
  test("skip leaves an existing page alone; overwrite replaces; fail reports", async () => {
    await run(mk("p2", "old body"), "agent-uone");
    expect((await run(mk("p2", "new body"), "agent-uone")).outcome).toBe("skipped");
    expect((await engine.getPage("p2", { sourceId: "agent-uone" }) as any).compiled_truth).toBe("old body");
    expect((await run(mk("p2", "new body"), "agent-uone", opts("overwrite"))).outcome).toBe("overwritten");
    expect((await engine.getPage("p2", { sourceId: "agent-uone" }) as any).compiled_truth).toBe("new body");
    expect((await run(mk("p2", "third"), "agent-uone", opts("fail"))).outcome).toBe("failed");
    expect((await engine.getPage("p2", { sourceId: "agent-uone" }) as any).compiled_truth).toBe("new body");
  });
  test("overwrite replaces chunks, tags and timeline instead of appending", async () => {
    await run(mk("p3", "v1", { tags: ["x", "y"] }), "agent-uone");
    await run(mk("p3", "v2", { tags: ["z"] }), "agent-uone", opts("overwrite"));
    const so = { sourceId: "agent-uone" };
    expect(await engine.getTags("p3", so)).toEqual(["z"]);
    expect((await engine.getTimeline("p3", so)).length).toBe(1);
    expect((await engine.getChunksWithEmbeddings("p3", so)).length).toBe(1);
  });
  test("dryRun writes nothing but reports the outcome", async () => {
    expect((await run(mk("p4", "dry"), "agent-uone", opts("skip", true))).outcome).toBe("written");
    expect(await engine.getPage("p4", { sourceId: "agent-uone" })).toBeNull();
  });
  test("a failure mid-page leaves nothing of that page behind", async () => {
    const bad = mk("p5", "boom", { timelineEntries: [{ date: "not-a-date", source: "s", summary: "x", detail: "" }] });
    expect((await run(bad, "agent-uone")).outcome).toBe("failed");
    expect(await engine.getPage("p5", { sourceId: "agent-uone" })).toBeNull();
  });
  test("a page without embeddings is written and counted", async () => {
    const p = mk("p6", "plain", { chunks: [{ index: 0, text: "plain", source: "compiled_truth", embedding: null, model: null, tokens: null }] });
    const r = await run(p, "agent-uone");
    expect(r.outcome).toBe("written");
    expect(r.noEmbedding).toBe(1);
  });
  test("two bundle sources mapped to one target: second same slug follows onConflict", async () => {
    await run(mk("dup", "from legacy", { source: "agent" }), "agent-utwo");
    expect((await run(mk("dup", "from default"), "agent-utwo")).outcome).toBe("skipped");
  });
  test("a link whose target page is absent is dropped and counted; a present one is written", async () => {
    await run(mk("ltarget", "target"), "agent-uone");
    const src = mk("lsrc", "source", { links: [
      { toSource: "agent-uone", toSlug: "ltarget", type: "references", context: "c" },
      { toSource: "agent-uone", toSlug: "missing", type: "references", context: "c" },
    ] });
    const r = await run(src, "agent-uone");
    expect(r.linksWritten).toBe(1);
    expect(r.linksDropped).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/brain-migrate/apply.test.ts`
Expected: FAIL, module `apply` not found.

- [ ] **Step 3: Implement**

```ts
// src/brain-migrate/apply.ts
import type { BundlePage } from "./bundle";
import type { MigrateEngine } from "./engine-types";

export type OnConflict = "skip" | "overwrite" | "fail";
export type PageOutcome = "written" | "skipped" | "overwritten" | "failed";
export interface ApplyPage { page: BundlePage; target: string; linkTargets: BundlePage["links"] }
export interface ApplyResult { outcome: PageOutcome; linksWritten: number; linksDropped: number; noEmbedding: number }

/**
 * Writes one page, whole or not at all. The whole write (page, chunks with the
 * carried embeddings, tags, timeline with its original dates, raw data) runs in
 * one engine transaction, so a failure leaves nothing of the page behind.
 * Links run after, in their own pass: a link needs both pages to exist, and a
 * target that is not in the brain is dropped and counted, never dangling.
 */
export async function applyPage(
  engine: MigrateEngine,
  a: ApplyPage,
  o: { onConflict: OnConflict; dryRun: boolean; ensureSource: (id: string) => Promise<void> },
): Promise<ApplyResult> {
  const { page: p, target } = a;
  const so = { sourceId: target };
  const none = (outcome: PageOutcome): ApplyResult => ({ outcome, linksWritten: 0, linksDropped: 0, noEmbedding: 0 });
  const noEmbedding = p.chunks.filter((c) => c.embedding === null).length;
  try {
    const exists = (await engine.getPage(p.slug, { ...so, includeDeleted: true })) !== null;
    if (exists && o.onConflict === "skip") return none("skipped");
    if (exists && o.onConflict === "fail") return none("failed");
    if (o.dryRun) return { ...none(exists ? "overwritten" : "written"), noEmbedding };
    await o.ensureSource(target);
    await engine.transaction(async (tx) => {
      if (exists) await tx.db.query("DELETE FROM pages WHERE slug = $1 AND source_id = $2", [p.slug, target]);
      await tx.putPage(p.slug, {
        type: p.type, title: p.title, compiled_truth: p.compiledTruth, timeline: p.timeline,
        frontmatter: p.frontmatter, ...(p.contentHash ? { content_hash: p.contentHash } : {}),
      }, so);
      if (p.chunks.length) {
        await tx.upsertChunks(p.slug, p.chunks.map((c) => ({
          chunk_index: c.index, chunk_text: c.text, chunk_source: c.source,
          ...(c.embedding ? { embedding: Float32Array.from(c.embedding) } : {}),
          ...(c.model ? { model: c.model } : {}), ...(c.tokens !== null ? { token_count: c.tokens } : {}),
        })), so);
      }
      for (const t of p.tags) await tx.addTag(p.slug, t, so);
      for (const e of p.timelineEntries) await tx.addTimelineEntry(p.slug, { date: e.date, source: e.source, summary: e.summary, detail: e.detail }, { ...so, skipExistenceCheck: true });
      for (const r of p.raw) await tx.putRawData(p.slug, r.source, r.data, so);
    });
    let linksWritten = 0, linksDropped = 0;
    for (const l of a.linkTargets) {
      if ((await engine.getPage(l.toSlug, { sourceId: l.toSource })) === null) { linksDropped++; continue; }
      await engine.addLink(p.slug, l.toSlug, l.context, l.type, "manual", undefined, undefined, { fromSourceId: target, toSourceId: l.toSource });
      linksWritten++;
    }
    return { outcome: exists ? "overwritten" : "written", linksWritten, linksDropped, noEmbedding };
  } catch {
    return none("failed");
  }
}
```

Spike inside this step: `DELETE FROM pages` must cascade chunks, tags, timeline, raw data and links (schema has `ON DELETE CASCADE` on `links`; confirm for `content_chunks`, `tags`, `timeline_entries`, `raw_data` with `grep -n "REFERENCES pages" node_modules/gbrain/src/core/pglite-schema.ts`). If a table does not cascade, delete from it explicitly in the same transaction. Also confirm `transaction` rolls back on throw on both engines (the p5 test proves it on PGLite).

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/brain-migrate/apply.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/brain-migrate/apply.ts tests/brain-migrate/apply.test.ts
git commit -m "feat(brain-migrate): transactional page write with conflict policy"
```

---

### Task 5: Import endpoint, token, mount

**Files:**
- Create: `src/gateway/brain-import/api.ts`
- Modify: `src/config/gateway-only-env.ts` (add `"SLAUDE_BRAIN_IMPORT_TOKEN"`), `src/config/env.ts` (accessor), `src/gateway/core/gateway.ts` (mount beside `deployApi`, ~line 3081 and the fetch chain that calls `deployApi.fetch`)
- Test: `tests/gateway/brain-import/api.test.ts`, extend `tests/config/` gateway-only test (find with `grep -rn "SLAUDE_BRAIN_TOKEN" tests/config`)

**Interfaces:**
- Consumes: `remapSource`, `validateMap`, `agentSourceForPersona`, `isAgentLike` (Task 1); `BundlePage` (Task 2); `applyPage`, `OnConflict` (Task 4); `timingSafeStringEqual` (`src/gateway/api/auth`), `json`, `readBodyCapped` (`src/gateway/api/http`); `livePersona`, `PersonaNotLiveError` (`src/persona/registry`); `agentIdReady` (`src/knowledge/agent-identity`); `brainEnabled`, `getBrain`, `ensureSource` (`src/knowledge/brain`); `brainMode` (`src/knowledge/brain-config`).
- Produces:
  ```ts
  export const BRAIN_IMPORT_MAX_BODY_BYTES = 4 * 1024 * 1024;
  export const BRAIN_IMPORT_MAX_PAGES = 100;
  export interface BrainImportDeps {
    env?: () => Record<string, string | undefined>;
    engine?: () => Promise<MigrateEngine>;                       // default: getBrain
    brainConfig?: () => { embeddingModel: string | null; embeddingDimensions: number | null }; // default: gbrain loadConfig
    resolveAgentId?: (persona: string) => Promise<string | null>; // default: see below
    ensureSource?: (id: string) => Promise<void>;
    brainOn?: () => { enabled: boolean; mode: "local" | "remote" };
    log?: (line: string) => void;
  }
  export function createBrainImportApi(deps?: BrainImportDeps): { fetch(req: Request): Promise<Response | null> };
  ```
  Request body zod shape: `{ dryRun?: boolean; onConflict?: "skip"|"overwrite"|"fail"; map?: Record<string,string>; engine: { embeddingModel: string|null; embeddingDimensions: number|null }; pages: BundlePage[] (max 100) }`. Response 200: `{ persona, agentSource, dryRun, sources: Record<target, { written; skipped; overwritten; failed; linksWritten; linksDropped; noEmbedding }>, failedSlugs: string[] }`.
  Default `resolveAgentId(persona)`: `persona === "default"` → `agentIdReady()`; otherwise `livePersona(persona)?.slackUserId ?? null` (a `PersonaNotLiveError` or `null` → 409; a persona with an empty Slack id → 409). Matches `brainGateFor` in `gateway.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/gateway/brain-import/api.test.ts
import { describe, expect, test } from "bun:test";
import { createBrainImportApi, type BrainImportDeps } from "../../../src/gateway/brain-import/api";
import type { BundlePage } from "../../../src/brain-migrate/bundle";
import type { MigrateEngine } from "../../../src/brain-migrate/engine-types";

const TOKEN = "t".repeat(40);
const URLP = (p = "ana") => `https://gw.example.com/brain-import/v1/personas/${p}`;
const pg = (source: string, slug: string, truth = "body " + slug): BundlePage => ({
  source, slug, type: "note", title: slug, compiledTruth: truth, timeline: "", frontmatter: {}, contentHash: null,
  chunks: [{ index: 0, text: truth, source: "compiled_truth", embedding: [0.1, 0.2], model: "m", tokens: 1 }],
  tags: [], timelineEntries: [], raw: [], links: [],
});
const body = (pages: BundlePage[], over: Record<string, unknown> = {}) => ({
  engine: { embeddingModel: "m", embeddingDimensions: 2 }, pages, ...over,
});
const post = (b: unknown, token: string | null = TOKEN, path = URLP()) =>
  new Request(path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(b) });

function fakeEngine() {
  const pages = new Map<string, number>();
  const writes: string[] = [];
  const e = {
    getPage: async (slug: string, o: any) => (pages.has(`${o.sourceId}/${slug}`) ? { slug } : null),
    transaction: async (fn: any) => fn(e),
    db: { query: async () => ({ rows: [] }) },
    putPage: async (slug: string, _p: any, o: any) => { pages.set(`${o.sourceId}/${slug}`, 1); writes.push(`${o.sourceId}/${slug}`); },
    upsertChunks: async () => {}, addTag: async () => {}, addTimelineEntry: async () => {}, putRawData: async () => {}, addLink: async () => {},
  };
  return { e: e as unknown as MigrateEngine, writes };
}
function api(over: Partial<BrainImportDeps> = {}) {
  const f = fakeEngine();
  const lines: string[] = [];
  return {
    ...f, lines,
    api: createBrainImportApi({
      env: () => ({ SLAUDE_BRAIN_IMPORT_TOKEN: TOKEN }),
      engine: async () => f.e,
      brainConfig: () => ({ embeddingModel: "m", embeddingDimensions: 2 }),
      resolveAgentId: async (n) => (n === "ana" ? "UANA-1x" : n === "default" ? "UBOTDEF" : null),
      ensureSource: async () => {},
      brainOn: () => ({ enabled: true, mode: "local" }),
      log: (l) => lines.push(l),
      ...over,
    }),
  };
}
const call = async (a: ReturnType<typeof api>, req: Request) => { const r = await a.api.fetch(req); return { status: r!.status, json: await r!.json() as any }; };

describe("auth and mount", () => {
  test("another prefix is not ours", async () => {
    expect(await api().api.fetch(new Request("https://gw/v1/x"))).toBeNull();
  });
  test("unset token: every method and path 404s, before anything else", async () => {
    const a = api({ env: () => ({}) });
    for (const [m, p] of [["POST", URLP()], ["GET", URLP()], ["POST", "https://gw/brain-import/x"]] as const) {
      expect((await call(a, new Request(p, { method: m }))).status).toBe(404);
    }
  });
  test("wrong or missing token is 401; a token of the wrong length is 401", async () => {
    const a = api();
    expect((await call(a, post(body([]), "x".repeat(40)))).status).toBe(401);
    expect((await call(a, post(body([]), null))).status).toBe(401);
    expect((await call(a, post(body([]), "short"))).status).toBe(401);
  });
  test("only POST on the persona path; unknown shapes 404", async () => {
    const a = api();
    expect((await call(a, new Request(URLP(), { method: "GET", headers: { authorization: `Bearer ${TOKEN}` } }))).status).toBe(405);
    expect((await call(a, post(body([]), TOKEN, "https://gw/brain-import/v1/nope"))).status).toBe(404);
  });
});

describe("refusals", () => {
  test("brain disabled and remote mode are 409", async () => {
    expect((await call(api({ brainOn: () => ({ enabled: false, mode: "local" }) }), post(body([])))).status).toBe(409);
    expect((await call(api({ brainOn: () => ({ enabled: true, mode: "remote" }) }), post(body([])))).status).toBe(409);
  });
  test("an unknown persona is 409", async () => {
    expect((await call(api(), post(body([]), TOKEN, URLP("ghost")))).status).toBe(409);
  });
  test("embedding mismatch is 409 naming both values; nothing written", async () => {
    const a = api();
    const r = await call(a, post(body([pg("agent-default", "s1")], { engine: { embeddingModel: "m", embeddingDimensions: 4 } })));
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/4/); expect(r.json.error).toMatch(/2/);
    expect(a.writes).toEqual([]);
  });
  test("a bundle with no embeddings skips the model check", async () => {
    const p = { ...pg("agent-default", "s1"), chunks: [{ index: 0, text: "t", source: "compiled_truth" as const, embedding: null, model: null, tokens: null }] };
    const a = api();
    expect((await call(a, post(body([p], { engine: { embeddingModel: null, embeddingDimensions: null } })))).status).toBe(200);
  });
  test("kb-* is 422 and an unmapped source is 422; neither echoes page text", async () => {
    const a = api();
    for (const src of ["kb-bulk-corpus", "scratch"]) {
      const r = await call(a, post(body([pg(src, "s", "TOP-SECRET-TEXT")])));
      expect(r.status).toBe(422);
      expect(JSON.stringify(r.json)).not.toContain("TOP-SECRET-TEXT");
    }
    expect(a.writes).toEqual([]);
  });
  test("a map into kb-* is 422", async () => {
    expect((await call(api(), post(body([pg("scratch", "s")], { map: { scratch: "kb-x" } })))).status).toBe(422);
  });
  test("oversize body 413, over 100 pages 422, non-JSON 422", async () => {
    const a = api();
    expect((await call(a, post(body(Array.from({ length: 101 }, (_, i) => pg("shared", "p" + i)))))).status).toBe(422);
    expect((await call(a, new Request(URLP(), { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "not json" }))).status).toBe(422);
    expect((await call(a, post(body([pg("shared", "big", "x".repeat(5 * 1024 * 1024))])))).status).toBe(413);
  });
});

describe("import", () => {
  test("agent-like sources land in the persona's sanitised agent slice; user/shared/public unchanged", async () => {
    const a = api();
    const r = await call(a, post(body([pg("agent-default", "a1"), pg("agent", "a2"), pg("user-ualice", "u1"), pg("shared", "s1"), pg("public", "p1")])));
    expect(r.status).toBe(200);
    expect(r.json.agentSource).toBe("agent-uana1x");
    expect(a.writes.sort()).toEqual(["agent-uana1x/a1", "agent-uana1x/a2", "public/p1", "shared/s1", "user-ualice/u1"]);
    expect(r.json.sources["agent-uana1x"].written).toBe(2);
  });
  test("the default persona maps to the process agent id's slice", async () => {
    const a = api();
    const r = await call(a, post(body([pg("agent-default", "d1")]), TOKEN, URLP("default")));
    expect(r.json.agentSource).toBe("agent-ubotdef");
  });
  test("dryRun writes nothing and reports counts", async () => {
    const a = api();
    const r = await call(a, post(body([pg("agent-default", "a1")], { dryRun: true })));
    expect(r.status).toBe(200);
    expect(r.json.dryRun).toBe(true);
    expect(a.writes).toEqual([]);
    expect(r.json.sources["agent-uana1x"].written).toBe(1);
  });
  test("a re-post under skip skips; failed slugs are slugs only", async () => {
    const a = api();
    await call(a, post(body([pg("shared", "s1")])));
    const r = await call(a, post(body([pg("shared", "s1")])));
    expect(r.json.sources["shared"].skipped).toBe(1);
  });
  test("audit line has persona, counts, dryRun, onConflict and no page text or slugs", async () => {
    const a = api();
    await call(a, post(body([pg("agent-default", "private/slug-xyz", "SECRET-BODY")])));
    expect(a.lines).toHaveLength(1);
    expect(a.lines[0]).toMatch(/persona=ana/); expect(a.lines[0]).toMatch(/dryRun=false/); expect(a.lines[0]).toMatch(/onConflict=skip/);
    expect(a.lines[0]).not.toContain("SECRET-BODY"); expect(a.lines[0]).not.toContain("slug-xyz");
  });
});
```

Config test (add to the existing gateway-only-env test file):

```ts
test("SLAUDE_BRAIN_IMPORT_TOKEN is gateway-only", () => {
  expect(isGatewayOnlyEnv("SLAUDE_BRAIN_IMPORT_TOKEN")).toBe(true);
});
```
Run `grep -rn "isGatewayOnlyEnv" tests | head` to find the file; also confirm the child-env scrub and the node boot check tests iterate the shared list (they should pick the name up with no further change; if one hardcodes names, add this one).

- [ ] **Step 2: Run to verify they fail**

Run: `bun test tests/gateway/brain-import tests/config`
Expected: FAIL (module missing; gateway-only assertion false).

- [ ] **Step 3: Implement**

Add `"SLAUDE_BRAIN_IMPORT_TOKEN"` to `GATEWAY_ONLY_ENV_NAMES` after `"SLAUDE_BRAIN_TOKEN"`. Add to `src/config/env.ts`, next to `deployToken`, an accessor following its exact style: `brainImportToken: () => process.env.SLAUDE_BRAIN_IMPORT_TOKEN?.trim() || undefined`.

```ts
// src/gateway/brain-import/api.ts
import { z } from "zod";
import { timingSafeStringEqual } from "../api/auth";
import { json, readBodyCapped } from "../api/http";
import { applyPage, type OnConflict } from "../../brain-migrate/apply";
import type { BundlePage } from "../../brain-migrate/bundle";
import type { MigrateEngine } from "../../brain-migrate/engine-types";
import { agentSourceForPersona, remapSource, validateMap } from "../../brain-migrate/remap";
import { agentIdReady } from "../../knowledge/agent-identity";
import { brainEnabled, ensureSource as ensureBrainSource, getBrain } from "../../knowledge/brain";
import { brainMode } from "../../knowledge/brain-config";
import { livePersona } from "../../persona/registry";

export const BRAIN_IMPORT_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const BRAIN_IMPORT_MAX_PAGES = 100;

export interface BrainImportDeps {
  env?: () => Record<string, string | undefined>;
  engine?: () => Promise<MigrateEngine>;
  brainConfig?: () => { embeddingModel: string | null; embeddingDimensions: number | null };
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

async function defaultBrainConfig(): Promise<{ embeddingModel: string | null; embeddingDimensions: number | null }> {
  const { loadConfig } = (await import(("gbrain/config") as string)) as { loadConfig: () => { embedding_model?: string; embedding_dimensions?: number } | null };
  const c = loadConfig() ?? {};
  return { embeddingModel: c.embedding_model ?? null, embeddingDimensions: c.embedding_dimensions ?? null };
}

export function createBrainImportApi(deps: BrainImportDeps = {}) {
  const readEnv = deps.env ?? (() => process.env);
  const log = deps.log ?? ((l: string) => console.log(l));

  async function fetch(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (url.pathname !== "/brain-import" && !url.pathname.startsWith("/brain-import/")) return null;
    const token = readEnv().SLAUDE_BRAIN_IMPORT_TOKEN?.trim();
    if (!token) return json(404, { error: "not found" });
    const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
    if (!m || !timingSafeStringEqual(m[1]!, token)) return json(401, { error: "invalid or missing brain-import token" });

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

    const target = await (deps.brainConfig ? Promise.resolve(deps.brainConfig()) : defaultBrainConfig());
    const hasVectors = b.pages.some((p) => p.chunks.some((c) => c.embedding !== null));
    if (hasVectors && (b.engine.embeddingModel !== target.embeddingModel || b.engine.embeddingDimensions !== target.embeddingDimensions)) {
      return json(409, { error: `embedding mismatch: bundle is ${b.engine.embeddingModel}/${b.engine.embeddingDimensions}, this brain is ${target.embeddingModel}/${target.embeddingDimensions}; align EMBEDDING_MODEL and EMBEDDING_DIMENSIONS or re-export` });
    }

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
    const ensure = deps.ensureSource ?? ensureBrainSource;
    const onConflict: OnConflict = b.onConflict ?? "skip";
    const dryRun = b.dryRun ?? false;
    const sources: Record<string, { written: number; skipped: number; overwritten: number; failed: number; linksWritten: number; linksDropped: number; noEmbedding: number }> = {};
    const failedSlugs: string[] = [];
    for (let i = 0; i < b.pages.length; i++) {
      const p = b.pages[i] as BundlePage;
      const t = targets[i]!;
      const linkTargets = p.links.map((l) => {
        const lr = remapSource(l.toSource, { agentSource, map: b.map });
        return { ...l, toSource: lr.ok ? lr.target : l.toSource };
      });
      const r = await applyPage(engine, { page: p, target: t, linkTargets }, { onConflict, dryRun, ensureSource: ensure });
      const s = (sources[t] ??= { written: 0, skipped: 0, overwritten: 0, failed: 0, linksWritten: 0, linksDropped: 0, noEmbedding: 0 });
      s[r.outcome]++; s.linksWritten += r.linksWritten; s.linksDropped += r.linksDropped; s.noEmbedding += r.noEmbedding;
      if (r.outcome === "failed" && !t.startsWith("user-")) failedSlugs.push(p.slug);
    }
    const counts = Object.entries(sources).map(([k, v]) => `${k}:w${v.written}/s${v.skipped}/o${v.overwritten}/f${v.failed}`).join(",");
    log(`[brain-import] persona=${persona} dryRun=${dryRun} onConflict=${onConflict} ${counts}`);
    return json(200, { persona, agentSource, dryRun, sources, failedSlugs });
  }
  return { fetch };
}
```

Mount: in `gateway.ts` next to `const deployApi = createDeployApi(...)` add `const brainImportApi = createBrainImportApi();` and, in the request chain where `deployApi.fetch(req)` is awaited, add an identical clause for `brainImportApi.fetch(req)` returning its response when non-null. (Read the lines around the existing `deployApi.fetch` call and follow its shape exactly.) The `/brain-import` prefix must not be reachable on a node role: confirm the node role never builds the gateway fetch chain; if it does, guard with the same condition `deployApi` uses.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/gateway/brain-import tests/config && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/brain-import/api.ts src/config/gateway-only-env.ts src/config/env.ts src/gateway/core/gateway.ts tests/gateway/brain-import tests/config
git commit -m "feat(gateway): token-guarded /brain-import route for persona memory"
```

---

### Task 6: Import client CLI

**Files:**
- Create: `src/cli/brain-import.ts` (logic in `src/brain-migrate/client.ts` so it is testable; the CLI file only parses argv and exits)
- Create: `src/brain-migrate/client.ts`
- Test: `tests/brain-migrate/client.test.ts`

**Interfaces:**
- Consumes: `verifyBundle`, `readPages`, `batchPages`, `BundleManifest` (Task 2); `remapSource`, `isAgentLike`, `agentSourceForPersona` is NOT used client-side (the gateway owns the target); the client only checks coverage with the table via `isAgentLike` and the allowed list.
- Produces:
  ```ts
  export interface ImportClientOptions {
    gateway: string; persona: string; token: string; bundle: string;
    dryRun?: boolean; onConflict?: "skip" | "overwrite" | "fail"; map?: Record<string, string>;
    fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; log?: (l: string) => void;
  }
  export interface ImportSummary { agentSource: string | null; sources: Record<string, { written: number; skipped: number; overwritten: number; failed: number; linksWritten: number; linksDropped: number; noEmbedding: number }>; failedSlugs: string[]; mismatches: string[] }
  export function runImport(o: ImportClientOptions): Promise<ImportSummary>; // throws ImportError on 4xx, checksum failure, uncovered source
  export class ImportError extends Error {}
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/brain-migrate/client.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleWriter, type BundlePage } from "../../src/brain-migrate/bundle";
import { ImportError, runImport } from "../../src/brain-migrate/client";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const page = (source: string, slug: string): BundlePage => ({
  source, slug, type: "note", title: slug, compiledTruth: "t", timeline: "", frontmatter: {}, contentHash: null,
  chunks: [], tags: [], timelineEntries: [], raw: [], links: [],
});
async function bundle(pages: BundlePage[]): Promise<string> {
  const d = mkdtempSync(join(tmpdir(), "cli-")); dirs.push(d);
  const w = new BundleWriter(d); for (const p of pages) await w.writePage(p);
  await w.finish({ engine: { schemaVersion: 1, embeddingModel: null, embeddingDimensions: null }, excluded: [] });
  return d;
}
const base = (b: string, over: Partial<Parameters<typeof runImport>[0]> = {}) => ({ gateway: "https://gw.example.com", persona: "ana", token: "tok", bundle: b, sleep: async () => {}, log: () => {}, ...over });
const ok = (counts: Record<string, number>) => new Response(JSON.stringify({ persona: "ana", agentSource: "agent-uana", dryRun: false, sources: Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, { written: n, skipped: 0, overwritten: 0, failed: 0, linksWritten: 0, linksDropped: 0, noEmbedding: 0 }])), failedSlugs: [] }), { status: 200 });

describe("runImport", () => {
  test("batches at 100 pages, sends the bearer token, aggregates counts, reconciles with the manifest", async () => {
    const pages = Array.from({ length: 250 }, (_, i) => page("agent-default", "p" + i));
    const sent: number[] = []; let auth = "";
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      auth = (init.headers as Record<string, string>).authorization!;
      const n = JSON.parse(init.body as string).pages.length; sent.push(n);
      return ok({ "agent-uana": n });
    }) as unknown as typeof fetch;
    const s = await runImport(base(await bundle(pages), { fetchImpl }));
    expect(sent).toEqual([100, 100, 50]);
    expect(auth).toBe("Bearer tok");
    expect(s.sources["agent-uana"]!.written).toBe(250);
    expect(s.mismatches).toEqual([]);
  });
  test("retries a 5xx with backoff, then succeeds", async () => {
    let n = 0;
    const fetchImpl = (async () => (++n < 3 ? new Response("bad", { status: 503 }) : ok({ shared: 1 }))) as unknown as typeof fetch;
    const s = await runImport(base(await bundle([page("shared", "a")]), { fetchImpl }));
    expect(n).toBe(3);
    expect(s.sources.shared!.written).toBe(1);
  });
  test("a 4xx stops the run with the gateway's message", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: "embedding mismatch: x" }), { status: 409 })) as unknown as typeof fetch;
    await expect(runImport(base(await bundle([page("shared", "a")]), { fetchImpl }))).rejects.toThrow(/embedding mismatch/);
  });
  test("a corrupted bundle fails before any request", async () => {
    const d = await bundle([page("shared", "a")]);
    const f = join(d, "pages.jsonl");
    await Bun.write(f, (await Bun.file(f).text()).replace('"t"', '"X"'));
    let called = false;
    await expect(runImport(base(d, { fetchImpl: (async () => { called = true; return ok({}); }) as unknown as typeof fetch }))).rejects.toThrow(/checksum/);
    expect(called).toBe(false);
  });
  test("an uncovered source stops the run before any request; a map covers it", async () => {
    const d = await bundle([page("scratch", "a")]);
    let called = false;
    const fetchImpl = (async () => { called = true; return ok({ shared: 1 }); }) as unknown as typeof fetch;
    await expect(runImport(base(d, { fetchImpl }))).rejects.toThrow(/scratch/);
    expect(called).toBe(false);
    const s = await runImport(base(d, { fetchImpl, map: { scratch: "shared" } }));
    expect(s.sources.shared!.written).toBe(1);
  });
  test("a count mismatch against the manifest is reported", async () => {
    const fetchImpl = (async () => ok({ shared: 0 })) as unknown as typeof fetch;
    const s = await runImport(base(await bundle([page("shared", "a")]), { fetchImpl }));
    expect(s.mismatches.length).toBe(1);
  });
  test("a mismatch that onConflict skip accounts for is not a mismatch", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ persona: "ana", agentSource: "agent-uana", dryRun: false, sources: { shared: { written: 0, skipped: 1, overwritten: 0, failed: 0, linksWritten: 0, linksDropped: 0, noEmbedding: 0 } }, failedSlugs: [] }), { status: 200 })) as unknown as typeof fetch;
    const s = await runImport(base(await bundle([page("shared", "a")]), { fetchImpl }));
    expect(s.mismatches).toEqual([]);
  });
  test("an empty bundle sends nothing and succeeds", async () => {
    let called = false;
    const s = await runImport(base(await bundle([]), { fetchImpl: (async () => { called = true; return ok({}); }) as unknown as typeof fetch }));
    expect(called).toBe(false);
    expect(s.mismatches).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/brain-migrate/client.test.ts`
Expected: FAIL, module `client` not found.

- [ ] **Step 3: Implement**

```ts
// src/brain-migrate/client.ts
import { batchPages, readPages, verifyBundle } from "./bundle";
import { isAgentLike } from "./remap";

export class ImportError extends Error {}
export interface SourceCounts { written: number; skipped: number; overwritten: number; failed: number; linksWritten: number; linksDropped: number; noEmbedding: number }
export interface ImportSummary { agentSource: string | null; sources: Record<string, SourceCounts>; failedSlugs: string[]; mismatches: string[] }
export interface ImportClientOptions {
  gateway: string; persona: string; token: string; bundle: string;
  dryRun?: boolean; onConflict?: "skip" | "overwrite" | "fail"; map?: Record<string, string>;
  fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; log?: (l: string) => void;
}

const COVERED = (s: string, map: Record<string, string>): boolean =>
  s in map || isAgentLike(s) || s === "shared" || s === "public" || /^user-[a-z0-9]+$/.test(s);

export async function runImport(o: ImportClientOptions): Promise<ImportSummary> {
  const doFetch = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = o.log ?? (() => {});
  const map = o.map ?? {};
  const manifest = await verifyBundle(o.bundle); // throws before any request on a bad checksum
  const uncovered = manifest.sources.map((s) => s.id).filter((s) => !COVERED(s, map));
  if (uncovered.length) throw new ImportError(`source(s) with no mapping: ${uncovered.join(", ")} (use --map from=to; kb-* sources are never imported)`);

  const url = `${o.gateway.replace(/\/$/, "")}/brain-import/v1/personas/${encodeURIComponent(o.persona)}`;
  const sources: Record<string, SourceCounts> = {};
  const failedSlugs: string[] = [];
  let agentSource: string | null = null;

  for await (const batch of batchPages(readPages(o.bundle), 100, 1_000_000)) {
    const body = JSON.stringify({
      dryRun: o.dryRun ?? false, onConflict: o.onConflict ?? "skip", ...(o.map ? { map: o.map } : {}),
      engine: { embeddingModel: manifest.engine.embeddingModel, embeddingDimensions: manifest.engine.embeddingDimensions },
      pages: batch,
    });
    let res: Response | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        res = await doFetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${o.token}` }, body });
        if (res.status < 500) break;
      } catch { res = null; }
      await sleep(Math.min(30_000, 500 * 2 ** attempt));
    }
    if (!res || res.status >= 500) throw new ImportError(`gateway unavailable after retries (${res?.status ?? "network error"})`);
    const j = (await res.json().catch(() => ({}))) as { error?: string; agentSource?: string; sources?: Record<string, SourceCounts>; failedSlugs?: string[] };
    if (res.status >= 400) throw new ImportError(`gateway refused the batch (${res.status}): ${j.error ?? "no message"}`);
    agentSource = j.agentSource ?? agentSource;
    for (const [k, c] of Object.entries(j.sources ?? {})) {
      const t = (sources[k] ??= { written: 0, skipped: 0, overwritten: 0, failed: 0, linksWritten: 0, linksDropped: 0, noEmbedding: 0 });
      for (const f of Object.keys(t) as Array<keyof SourceCounts>) t[f] += c[f] ?? 0;
    }
    failedSlugs.push(...(j.failedSlugs ?? []));
    log(`batch of ${batch.length} sent`);
  }

  // Reconcile: every manifest page must be accounted for by an outcome, after mapping.
  const expected: Record<string, number> = {};
  for (const s of manifest.sources) {
    // The gateway owns the agent target; here we only need totals per outcome group.
    const key = isAgentLike(s.id) && !(s.id in map) ? "__agent__" : (map[s.id] ?? s.id);
    expected[key] = (expected[key] ?? 0) + s.pages;
  }
  const got: Record<string, number> = {};
  for (const [k, c] of Object.entries(sources)) {
    const key = agentSource && k === agentSource ? "__agent__" : k;
    got[key] = (got[key] ?? 0) + c.written + c.skipped + c.overwritten + c.failed;
  }
  const mismatches: string[] = [];
  for (const [k, n] of Object.entries(expected)) {
    if ((got[k] ?? 0) !== n) mismatches.push(`${k === "__agent__" ? "agent slice" : k}: expected ${n} pages, gateway accounted for ${got[k] ?? 0}`);
  }
  return { agentSource, sources, failedSlugs, mismatches };
}
```

Note on reconcile: `skipped` counts as accounted-for (the spec's "pages the chosen `onConflict` accounts for"); `failed` also counts as accounted-for here but is surfaced separately, and the CLI exits non-zero when `failedSlugs.length > 0` or `mismatches.length > 0`.

```ts
// src/cli/brain-import.ts
import { parseArgs } from "node:util";
import { ImportError, runImport } from "../brain-migrate/client";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    gateway: { type: "string" }, persona: { type: "string" }, "token-env": { type: "string" },
    "dry-run": { type: "boolean" }, "on-conflict": { type: "string" }, map: { type: "string", multiple: true },
  },
});
const bundle = positionals[0];
const tokenEnv = values["token-env"] ?? "SLAUDE_BRAIN_IMPORT_TOKEN";
const token = process.env[tokenEnv];
if (!values.gateway || !values.persona || !bundle) {
  console.error("usage: brain-import --gateway <url> --persona <name> [--token-env VAR] [--dry-run] [--on-conflict skip|overwrite|fail] [--map from=to ...] <bundle>");
  process.exit(2);
}
if (!token) { console.error(`set ${tokenEnv} in the environment (never a flag)`); process.exit(2); }
const map = Object.fromEntries((values.map ?? []).map((m) => { const i = m.indexOf("="); return [m.slice(0, i), m.slice(i + 1)]; }));
try {
  const s = await runImport({
    gateway: values.gateway, persona: values.persona, token, bundle,
    dryRun: !!values["dry-run"], onConflict: values["on-conflict"] as "skip" | "overwrite" | "fail" | undefined,
    ...(Object.keys(map).length ? { map } : {}), log: (l) => console.log(l),
  });
  console.log(`${values["dry-run"] ? "DRY RUN " : ""}target agent slice: ${s.agentSource}`);
  for (const [k, c] of Object.entries(s.sources)) console.log(`  ${k.padEnd(34)} written=${c.written} skipped=${c.skipped} overwritten=${c.overwritten} failed=${c.failed} links=${c.linksWritten}/${c.linksDropped} dropped no-embedding=${c.noEmbedding}`);
  if (s.failedSlugs.length) console.error(`failed pages: ${s.failedSlugs.join(", ")}`);
  for (const m of s.mismatches) console.error(`MISMATCH ${m}`);
  process.exit(s.failedSlugs.length || s.mismatches.length ? 1 : 0);
} catch (e) {
  console.error(e instanceof ImportError || e instanceof Error ? e.message : String(e));
  process.exit(1);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/brain-migrate/client.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/brain-migrate/client.ts src/cli/brain-import.ts tests/brain-migrate/client.test.ts
git commit -m "feat(brain-migrate): brain-import client with batching, retry and reconciliation"
```

---

### Task 7: The scenario test: mono default slice migrated to the gateway, memory still works

This is the test the operator asked for. A mono-mode agent learns things in its default slice; the brain is exported, imported into a *separate, fresh* gateway-side brain under a named persona, and the persona must recall everything, with the new write path still working.

**Files:**
- Create: `tests/brain-migrate/scenario-mono-to-gateway.test.ts`
- Create (optional second file, Postgres): `tests/brain-migrate/scenario-pg.test.ts`

**Interfaces:**
- Consumes: `seedMonoBrain`, `TEST_DIMS`, `vec` (Task 3 `seed.ts`); `exportBrain` (Task 3); `runImport` (Task 6); `createBrainImportApi` (Task 5); `BrainMemoryProvider` (`src/memory/brain-provider`); `brainCall`, `closeBrain`, `getBrain` (`src/knowledge/brain`); `setAgentId`, `resetAgentId` (`src/knowledge/agent-identity`); `agentSourceForPersona` (Task 1).
- Produces: nothing later tasks use.

Phases (each is a `test`, run in order in one `describe`; module state is switched by changing `SLAUDE_BRAIN_HOME` then `closeBrain()`):

1. **mono**: `seedMonoBrain(monoHome)` (Task 3). Assert, through `brainCall("search", …, agentScope())` with the mono identity `default`, that the conversation page and the learned page are found in `agent-default`. This proves the baseline: the old agent remembers.
2. **export**: `exportBrain({ home: monoHome, out })`.
3. **gateway brain**: `process.env.SLAUDE_BRAIN_HOME = gwHome`; fresh `getBrain()`. Build the endpoint with `createBrainImportApi({ env: () => ({ SLAUDE_BRAIN_IMPORT_TOKEN: TOKEN }), resolveAgentId: async (n) => n === "ana" ? "UANA-1x" : null, brainConfig: () => <read from the gateway brain's config.json as the default does> })` and run the real `runImport` with `fetchImpl: (u, init) => api.fetch(new Request(u, init))`. Dry run first: assert the printed target is `agent-uana1x`, counts are right, and the gateway brain is still empty.
4. **apply**: real run. Assert summary counts and `mismatches` empty.
5. **recall after migration** (the point of the scenario), all through the gateway's own read paths, with the persona's identity `setAgentId("UANA-1x")`:
   - `brainCall("search", { query: "zebra procedure" }, agentScope())` finds `learned/runbook` (keyword search works without re-embedding).
   - `new BrainMemoryProvider().prefetch(session)` for the same session id seeded in mono returns a block containing `deploy cadence` and `rotates monday`: the migrated conversation continues, and a new `syncTurn` on the same session appends to the same page (read back contains old and new turns).
   - Embeddings survived: `getChunksWithEmbeddings("learned/runbook", { sourceId: "agent-uana1x" })` returns the exact vector from `vec(2)` (within 1e-5), model `test-embed`.
   - Tags (`ops`), the timeline entry dated `2024-03-05`, the raw data and the link `learned/index → learned/runbook` are present in the persona's slice.
   - `kb_*`: no `kb-bulk-corpus` source exists in the gateway brain and no page `kb/page` is found anywhere.
6. **isolation**: with a scope for another persona (`agentSourceForPersona("UOTHER")`) the migrated `zebra procedure` page is not visible; with Alice's scope (`user-ualice`, shared) `quokka` is visible, with Bob's scope (`shared` only) it is not; `narwhal` (shared) and `pelican` (public) are visible to a trusted scope that includes them.
7. **re-run is idempotent**: run `runImport` again with the default `skip`; every page is `skipped`, nothing written, no mismatch. Then a partial-crash simulation: delete two pages from the gateway brain (SQL on `engine.db`), re-run, assert exactly those two are written.
8. **default persona variant**: repeat phases 3-5 once with persona `default` and a gateway agent id `UBOTDEF`, asserting the data lands in `agent-ubotdef` (the persona the operator's mono agent becomes when it is the gateway's default persona).
9. **a new write after migration still works and does not disturb old memory**: `brainCall("put_page", { slug: "learned/new", content: "Fresh note about a platypus." }, agentScope())`, search finds both old (`zebra`) and new (`platypus`); `BrainMemoryProvider.syncTurn` on a fresh session writes a conversation page into `agent-uana1x`.

- [ ] **Step 1: Write the test** (full code; names above are exact)

```ts
// tests/brain-migrate/scenario-mono-to-gateway.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedMonoBrain, vec } from "./seed";

const root = mkdtempSync(join(tmpdir(), "bm-scenario-"));
const monoHome = join(root, "mono");
const gwHome = join(root, "gateway");
const bundleDir = join(root, "bundle");
const TOKEN = "s".repeat(40);
const SESSION = "11111111-2222-3333-4444-555555555555";
afterAll(async () => {
  const { closeBrain } = await import("../../src/knowledge/brain");
  await closeBrain();
  rmSync(root, { recursive: true, force: true });
});

const useBrain = async (home: string) => {
  const { closeBrain } = await import("../../src/knowledge/brain");
  await closeBrain();
  process.env.SLAUDE_BRAIN_HOME = home;
};
const identity = async (id: string | null) => {
  const m = await import("../../src/knowledge/agent-identity");
  m.resetAgentId();
  if (id) m.setAgentId(id);
};
const brainConfigOf = (home: string) => {
  try {
    const c = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    return { embeddingModel: c.embedding_model ?? null, embeddingDimensions: c.embedding_dimensions ?? null };
  } catch { return { embeddingModel: null, embeddingDimensions: null }; }
};
const importer = async (persona: string, agentId: string, over: Record<string, unknown> = {}) => {
  const { createBrainImportApi } = await import("../../src/gateway/brain-import/api");
  const { runImport } = await import("../../src/brain-migrate/client");
  const api = createBrainImportApi({
    env: () => ({ SLAUDE_BRAIN_IMPORT_TOKEN: TOKEN }),
    resolveAgentId: async (n) => (n === persona ? agentId : null),
    brainConfig: () => brainConfigOf(monoHome), // same embedding config as the old brain (the supported case)
    log: () => {},
  });
  return (extra: Record<string, unknown> = {}) => runImport({
    gateway: "https://gw.example.com", persona, token: TOKEN, bundle: bundleDir, sleep: async () => {}, log: () => {},
    fetchImpl: ((u: string, init: RequestInit) => api.fetch(new Request(u, init)).then((r) => r!)) as unknown as typeof fetch,
    ...over, ...extra,
  });
};
const search = async (q: string, scope: import("../../src/knowledge/scope").BrainScope) => {
  const { brainCall } = await import("../../src/knowledge/brain");
  return (await brainCall("search", { query: q }, scope)) as Array<{ slug?: string; source_id?: string }>;
};
const scopeOf = async (src: string, extra: string[] = []) => ({ clientId: src, sourceId: src, allowedSources: [src, ...extra] });

describe("mono default slice -> gateway persona: memory remains", () => {
  test("1. mono: the old agent remembers in agent-default", async () => {
    await seedMonoBrain(monoHome);
    await useBrain(monoHome);
    await identity(null); // mono: no SLAUDE_AGENT_ID, no auth.test -> "default"
    const { agentScope } = await import("../../src/knowledge/agent-identity");
    expect(agentScope().sourceId).toBe("agent-default");
    expect((await search("zebra procedure", agentScope())).length).toBeGreaterThan(0);
    const { BrainMemoryProvider } = await import("../../src/memory/brain-provider");
    expect(await new BrainMemoryProvider().prefetch(SESSION)).toContain("deploy cadence");
  }, 120_000);

  test("2. export the mono brain", async () => {
    const { closeBrain } = await import("../../src/knowledge/brain");
    await closeBrain();
    const { exportBrain } = await import("../../src/brain-migrate/export");
    const { manifest } = await exportBrain({ home: monoHome, out: bundleDir });
    expect(manifest.sources.map((s) => s.id)).toContain("agent-default");
    expect(manifest.excluded).toContain("kb-bulk-corpus");
  }, 120_000);

  test("3. dry run into a fresh gateway brain reports the target and writes nothing", async () => {
    await useBrain(gwHome);
    await identity("UANA-1x");
    const run = await importer("ana", "UANA-1x");
    const s = await run({ dryRun: true });
    expect(s.agentSource).toBe("agent-uana1x");
    expect(s.sources["agent-uana1x"]!.written).toBeGreaterThan(0);
    const { getBrain } = await import("../../src/knowledge/brain");
    const e = (await getBrain()) as any;
    const n = (await e.db.query("SELECT count(*)::int AS n FROM pages")).rows[0].n;
    expect(n).toBe(0);
  }, 120_000);

  test("4. real import: counts reconcile", async () => {
    const run = await importer("ana", "UANA-1x");
    const s = await run();
    expect(s.mismatches).toEqual([]);
    expect(s.failedSlugs).toEqual([]);
    expect(s.sources["agent-uana1x"]!.written).toBe(3); // 2 learned pages + the conversation page
    expect(s.sources["user-ualice"]!.written).toBe(1);
    expect(Object.keys(s.sources).some((k) => k.startsWith("kb-"))).toBe(false);
  }, 120_000);

  test("5. the persona recalls everything through the gateway's own read paths", async () => {
    const { agentScope } = await import("../../src/knowledge/agent-identity");
    const { getBrain } = await import("../../src/knowledge/brain");
    expect(agentScope().sourceId).toBe("agent-uana1x");
    expect((await search("zebra procedure", agentScope())).length).toBeGreaterThan(0);
    const { BrainMemoryProvider } = await import("../../src/memory/brain-provider");
    const mem = new BrainMemoryProvider();
    const block = await mem.prefetch(SESSION);
    expect(block).toContain("deploy cadence");
    expect(block).toContain("rotates monday");
    await mem.syncTurn({ sessionId: SESSION, user: "after the move?", assistant: "still here" });
    const after = await mem.prefetch(SESSION);
    expect(after).toContain("deploy cadence"); expect(after).toContain("still here");
    const e = (await getBrain()) as any;
    const ch = await e.getChunksWithEmbeddings("learned/runbook", { sourceId: "agent-uana1x" });
    expect(Array.from(ch[0].embedding as Float32Array)[5]).toBeCloseTo(vec(2)[5]!, 5);
    expect(ch[0].model).toBe("test-embed");
    expect(await e.getTags("learned/runbook", { sourceId: "agent-uana1x" })).toContain("ops");
    expect(String((await e.getTimeline("learned/runbook", { sourceId: "agent-uana1x" }))[0].date)).toContain("2024-03-05");
    expect((await e.getRawData("learned/runbook", undefined, { sourceId: "agent-uana1x" }))[0].data).toEqual({ k: "v" });
    const links = (await e.db.query(`SELECT count(*)::int AS n FROM links`)).rows[0].n;
    expect(links).toBeGreaterThanOrEqual(1);
    const kb = (await e.db.query(`SELECT count(*)::int AS n FROM sources WHERE id LIKE 'kb-%'`)).rows[0].n;
    expect(kb).toBe(0);
  }, 120_000);

  test("6. isolation: other agents and other people do not see the migrated private slices", async () => {
    const other = await scopeOf("agent-uother");
    expect((await search("zebra procedure", other)).length).toBe(0);
    const alice = await scopeOf("user-ualice", ["shared"]);
    const bob = await scopeOf("shared");
    expect((await search("quokka", alice)).length).toBeGreaterThan(0);
    expect((await search("quokka", bob)).length).toBe(0);
    expect((await search("narwhal", bob)).length).toBeGreaterThan(0);
    expect((await search("pelican", await scopeOf("public"))).length).toBeGreaterThan(0);
    expect((await search("bulk corpus", await scopeOf("agent-uana1x", ["shared", "public", "user-ualice"]))).length).toBe(0);
  }, 120_000);

  test("7. re-run is idempotent; a crashed run resumes", async () => {
    const run = await importer("ana", "UANA-1x");
    const s = await run();
    expect(Object.values(s.sources).every((c) => c.written === 0 && c.failed === 0)).toBe(true);
    expect(s.mismatches).toEqual([]);
    const { getBrain } = await import("../../src/knowledge/brain");
    const e = (await getBrain()) as any;
    await e.db.query(`DELETE FROM pages WHERE slug IN ('learned/index','team/norms')`);
    const s2 = await run();
    const written = Object.values(s2.sources).reduce((n, c) => n + c.written, 0);
    expect(written).toBe(2);
  }, 120_000);

  test("8. a new write after the move works and the old memory is intact", async () => {
    const { agentScope } = await import("../../src/knowledge/agent-identity");
    const { brainCall } = await import("../../src/knowledge/brain");
    await brainCall("put_page", { slug: "learned/new", content: "Fresh note about a platypus." }, agentScope());
    expect((await search("platypus", agentScope())).length).toBeGreaterThan(0);
    expect((await search("zebra procedure", agentScope())).length).toBeGreaterThan(0);
  }, 120_000);

  test("9. the same bundle into the default persona lands in the process agent's slice", async () => {
    await useBrain(join(root, "gateway-default"));
    await identity("UBOTDEF");
    const run = await importer("default", "UBOTDEF");
    const s = await run();
    expect(s.agentSource).toBe("agent-ubotdef");
    const { agentScope } = await import("../../src/knowledge/agent-identity");
    expect((await search("zebra procedure", agentScope())).length).toBeGreaterThan(0);
  }, 120_000);
});
```

Pitfall to verify while writing: a conversation page written by `BrainMemoryProvider` in mono lands under `agentScope()` whose `allowedSources` also includes the legacy `agent` source; `prefetch` reads through that scope, so after the move it must find the page in `agent-uana1x`. The test pins this. If `getBrain`'s boot clears locks or `ensureSources` creates `shared`/`public` at gateway boot, the "brain is empty" assertion in test 3 should count `pages`, not sources (as written).

- [ ] **Step 2: Run to verify it fails for the right reason**

Run: `bun test tests/brain-migrate/scenario-mono-to-gateway.test.ts`
Expected before Tasks 1-6 land: FAIL on missing modules. After Tasks 1-6: this task adds no source code, so it should pass; if any phase fails, the failure is a real defect in Tasks 3-6: fix it there (re-run that task's tests too), never loosen the scenario.

- [ ] **Step 3: Postgres variant (gated)**

Create `tests/brain-migrate/scenario-pg.test.ts` that `describe.skipIf(!process.env.SLAUDE_BRAIN_PG_TEST_URL)`: the same phases 3-5 and 7, with the gateway-side brain on Postgres via `SLAUDE_BRAIN_ENGINE=postgres` and `SLAUDE_BRAIN_DATABASE_URL=$SLAUDE_BRAIN_PG_TEST_URL` (use a throwaway database name; drop the pages in `afterAll`). It proves the production target (Postgres/pgvector), including the transactional write and the vector round trip. Export still reads a PGLite mono brain. Add the env to the CI job that already runs `SLAUDE_DB=pg` suites only if one exists for the brain database; otherwise document the variable in the runbook as a manual check. Share the phase bodies by moving them into `tests/brain-migrate/scenario-steps.ts` exporting functions both files call (keep the PGLite file self-contained until a second consumer exists: extract in this step, not earlier).

- [ ] **Step 4: Run both**

Run: `bun test tests/brain-migrate && bun run typecheck`, then, if a Postgres is available, `SLAUDE_BRAIN_PG_TEST_URL=postgres://localhost/slaude_brain_test bun test tests/brain-migrate/scenario-pg.test.ts`
Expected: PASS (the Postgres file reports skipped when the variable is unset).

- [ ] **Step 5: Commit**

```bash
git add tests/brain-migrate/scenario-mono-to-gateway.test.ts tests/brain-migrate/scenario-pg.test.ts tests/brain-migrate/scenario-steps.ts
git commit -m "test(brain-migrate): mono default slice migrated to a gateway persona still recalls"
```

---

### Task 8: Security test, runbook, config docs, field note

**Files:**
- Test: `tests/brain-migrate/security.test.ts`
- Create: `docs/site/_content/deploy/brain-migration.md`
- Modify: `docs/site/_content/reference/configuration.md` (row for `SLAUDE_BRAIN_IMPORT_TOKEN`), docs nav (find the deploy section entries with `grep -rn "multi-node" docs/site --include=*.json`), `docs/site/_content/deploy/multi-node.md` (one link), `CLAUDE.md` Findings Log (one line, newest first), `docs/site/_content/field-notes/2026-10-07-brain-migration.md`
- Modify: `docs/superpowers/plans/2026-10-04-ha-delivery-process.md`: add a short "Brain migration" row pointing at this plan.

- [ ] **Step 1: Write the failing security test**

```ts
// tests/brain-migrate/security.test.ts
import { describe, expect, test } from "bun:test";
import { gatewayOnlyEnvPresent, isGatewayOnlyEnv } from "../../src/config/gateway-only-env";

describe("SLAUDE_BRAIN_IMPORT_TOKEN is gateway-only", () => {
  test("listed", () => expect(isGatewayOnlyEnv("SLAUDE_BRAIN_IMPORT_TOKEN")).toBe(true));
  test("a node holding it is reported (so node boot refuses)", () => {
    expect(gatewayOnlyEnvPresent({ SLAUDE_BRAIN_IMPORT_TOKEN: "x" })).toEqual(["SLAUDE_BRAIN_IMPORT_TOKEN"]);
  });
  test("the agent child env scrub removes it", async () => {
    const mod = await import("../../src/agent/child-env");
    const scrub = (mod as any).scrubChildEnv ?? (mod as any).childEnv;
    expect(scrub, "adapt to the exported scrub function name in src/agent/child-env.ts").toBeTruthy();
    const out = scrub({ SLAUDE_BRAIN_IMPORT_TOKEN: "x", PATH: "/bin" });
    expect(out.SLAUDE_BRAIN_IMPORT_TOKEN).toBeUndefined();
  });
});
```
Adapt the third test to the real exported function after reading `src/agent/child-env.ts` (it consumes `GATEWAY_ONLY_ENV_NAMES`, so it passes with no code change). Also assert in the same file that no brain-import source file or CLI reads `SLAUDE_JOB_SECRET`, `SLAUDE_BRAIN_DATABASE_URL` or `SLAUDE_PG_URL`: `readFileSync` each of `src/cli/brain-import.ts`, `src/cli/brain-export.ts`, `src/brain-migrate/client.ts` and assert none of those names appears, and that `src/cli/brain-import.ts` has no `--token` option.

- [ ] **Step 2: Run to verify** (`bun test tests/brain-migrate/security.test.ts`; fix the adapt note, expect PASS) and commit `test(brain-migrate): import token is gateway-only and the CLIs hold no gateway secret`.

- [ ] **Step 3: Runbook** `docs/site/_content/deploy/brain-migration.md` (follow the frontmatter of a sibling page such as `multi-node.md`). Sections, in order, each with exact commands and the expected output line:
  1. What moves and what does not (memory slices only; `kb-*` re-synced from git; sessions and cron via `migrate-sqlite`; remote brain mode unsupported).
  2. Preconditions: the persona exists in the gateway (personas as code) with a Slack user id; `EMBEDDING_MODEL`/`EMBEDDING_DIMENSIONS` equal on both sides (state the refusal text); a Postgres backup of the brain database (`pg_dump`) before the first non-dry run.
  3. Stop the old pod (or snapshot the volume), then `bun run brain-export --home /data/brain --out ./bundle` and read the inventory; note which sources are agent-like.
  4. Set `SLAUDE_BRAIN_IMPORT_TOKEN` on the gateway Secret only (never nodes), roll the gateway.
  5. `export SLAUDE_BRAIN_IMPORT_TOKEN=...; bun run brain-import --gateway https://<gateway> --persona <name> --dry-run ./bundle`; read the printed `target agent slice` and the counts.
  6. Apply without `--dry-run`; exit code 0 means reconciled. Importing before the persona's Slack traffic is cut over; `shared`/`public` first-import-wins under `skip` (import `shared` from one reference agent; use `--map shared=...` or `--on-conflict overwrite` deliberately).
  7. Verify: ask the persona a question only the old agent knew; check `/panel` persona view.
  8. Cleanup: unset the token, roll the gateway; keep the bundle private (it holds user memory) and delete it when done.
  9. Rollback: nothing outside the persona's slices was written; to undo, restore the backup, or delete the persona's `agent-*` pages by source.
  10. Troubleshooting table: each refusal message, cause, fix.
  Generic placeholders only.

- [ ] **Step 4: Config reference row**, nav entry, link from `multi-node.md`, field note `2026-10-07-brain-migration.md` (mechanism, decisions: reads a copy; embeddings carried not re-made; agent slice derived through `agentSourceId` not typed; transactional page write; link drop policy; what was measured in the Task 3 and 4 spikes; what was not verified: Postgres at scale, bundles over a few GB), `CLAUDE.md` Findings Log line, tracker row.

- [ ] **Step 5: Full verification**

Run, in order, and read the output:
```bash
bun run typecheck
bun test tests/brain-migrate tests/gateway/brain-import tests/config tests/brain.test.ts tests/brain-memory.test.ts
bun test tests/gateway tests/deploy   # unrelated suites touched by gateway.ts / env list
shellcheck $(git ls-files '*.sh') 2>&1 | head   # only if scripts changed (none expected)
git diff main... -U0 | grep -nIiE 'acme|\.acme\.|\.slack\.com|squadrondevel|\b[CUTGW]0[A-Z0-9]{8,}\b|AKIA[0-9A-Z]{16}|xox[baprs]-|ghp_|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|deepseek|real-employee-names'
git status --short   # no .handoff, .mcp.json, *.png, *.log
```
Expected: typecheck exit 0, tests PASS (rerun any failure alone; known flakes in the tracker are not new), leak scan prints nothing except intentional placeholders (`UTESTUSER1`, `UANA-1x` are fake). The docs site build command is the one CI uses (find it in `.github/workflows/*.yml`; run it).

- [ ] **Step 6: Commit**

```bash
git add docs/site docs/superpowers/plans CLAUDE.md
git commit -m "docs: brain migration runbook, config reference, field note"
```

---

## Self-Review

**Spec coverage:** §4.1 bundle: Task 2. §4.2 export (copy, engine direct, filter, streaming, manifest last, inventory print): Task 3. §4.3 endpoint (token, 404-unset, 4 MB, 100 pages, refusals incl. remote/disabled/persona/embedding/kb/unmapped, per-page writes, response, audit): Task 5 + Task 4. §4.4 remap incl. map rules and link remap: Tasks 1 and 5 (link remap in the endpoint, drop in `applyPage`). §4.5 conflicts: Task 4. §4.6 client (env token, verify, batches, retry, dry run, reconcile, uncovered refusal): Task 6. §4.7 safety: Tasks 5, 6, 8. §6 edge cases: empty brain (3), no embeddings (4, 5), soft-deleted (3 uses default listing; apply checks `includeDeleted` for conflicts), resume/crash (4, 7), wrong persona (dry run in 6/7), concurrent writers (skip, 7). §7 testing: units in 1, 2, 6; integration in 4, 5, 7; security in 5, 8; the operator's mono-to-gateway scenario in 7. §8 rollout: no RC; no `package.json` edit (Global Constraints). §9 open items: transactional form resolved in Task 4 (`engine.transaction` exists, rollback test); compression deferred (noted in field note).

**Spec deviation, called out:** the spec writes the target as `agent-<persona.slackUserId>`; the plan derives it with `agentSourceId()` (sanitised, dashes dropped, 32 chars) because that is the slice the gateway's own memory and KB paths read (`brainGateFor` → `agentSourceId`). Writing a literal `agent-<id>` would orphan the data for any id the sanitiser changes. Update the spec's §4.4 sentence in Task 8 Step 4 to say so.

**Placeholder scan:** none left; spike steps (Task 3 Step 1, Task 4 Step 3 cascade check) are bounded investigations with a stated fallback, not deferred work.

**Type consistency:** `MigrateEngine` (Task 3) is what `applyPage` (4), the endpoint (5) and the scenario (7) use; `BundlePage` field names (`compiledTruth`, `timelineEntries`, `raw`, `links[].toSource/toSlug/type/context`) are identical in Tasks 2, 3, 4, 5, 6; `OnConflict` and outcome keys (`written|skipped|overwritten|failed`) match between 4, 5 and 6; `agentSourceForPersona` is defined in 1 and used in 5 and 7.
