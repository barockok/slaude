# Writable KB + Ingest Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single writable knowledge base that the agent populates `raw/` from in normal Slack turns, with on-demand ingest synthesis (raw/ → wiki/) triggered by `/ingest`, serialized by a sqlite mutex, and pushed to git at end of ingest.

**Architecture:** Two new top-level manifest fields — `slaude_skills` (push target for runtime-authored skills) and `slaude_knowledge` (push target for the writable KB). The existing `skills[]` / `knowledge[]` arrays stay but become strictly read-only (pull-only via `sync_manifest`). `/ingest` runs a fresh SDK sub-query whose system prompt = `RUNTIME_BASELINE + <persona> + writable-KB README.md` against `~/.slaude/knowledge/<label>/`. A sqlite `kb_ingest_jobs` table provides a global mutex. Git push happens only at ingest end (for wiki/) plus opportunistically by `sync_manifest` (for raw/).

**Tech Stack:** Bun + TypeScript, bun:sqlite, zod, @anthropic-ai/claude-agent-sdk.

---

## File map

**Modified:**
- `src/config/manifest-schema.ts` — add `slaude_skills`, `slaude_knowledge` schemas
- `src/skills/sync-manifest.ts` — rewrite around new fields, add pull-mode + raw-only push
- `src/db/schema.ts` — add `kb_ingest_jobs` table
- `src/gateway/slack/commands.ts` — add `/ingest` parsing
- `src/gateway/slack/adapter.ts` — wire `/ingest` to ingest engine
- `src/soul/loader.ts` — KB baseline updated for raw/wiki discipline
- `src/cli/install.ts` — install `slaude_skills` + `slaude_knowledge` clones at build time
- `src/skills/mcp-tools.ts` — refresh `sync_manifest` tool description
- `README.md`, `CLAUDE.md` — docs + findings log

**Created:**
- `src/db/ingest-jobs.ts` — sqlite-backed mutex (acquire/release/heartbeat/stale-cleanup)
- `src/knowledge/ingest.ts` — ingest engine (sub-query driver + push)
- `tests/ingest-jobs.test.ts`
- `tests/ingest.test.ts`

**Test files modified:**
- `tests/manifest-schema.test.ts`, `tests/sync-manifest.test.ts`, `tests/commands.test.ts`, `tests/config.test.ts`

---

### Task 1: Manifest schema — `slaude_skills` top-level field

**Files:**
- Modify: `src/config/manifest-schema.ts`
- Test: `tests/manifest-schema.test.ts`

- [ ] **Step 1: Write failing tests for `slaude_skills`**

Append to `tests/manifest-schema.test.ts`:

```ts
describe("manifestSchema slaude_skills", () => {
  test("accepts manifest without slaude_skills (optional)", () => {
    const r = manifestSchema.parse({});
    expect(r.slaude_skills).toBeUndefined();
  });

  test("accepts manifest with slaude_skills", () => {
    const r = manifestSchema.parse({
      slaude_skills: { git: "github:owner/my-skills", ref: "main" },
    });
    expect(r.slaude_skills?.git).toBe("github:owner/my-skills");
    expect(r.slaude_skills?.ref).toBe("main");
  });

  test("rejects slaude_skills with missing git", () => {
    expect(() => manifestSchema.parse({ slaude_skills: { ref: "main" } })).toThrow();
  });

  test("rejects slaude_skills with missing ref", () => {
    expect(() => manifestSchema.parse({ slaude_skills: { git: "github:owner/repo" } })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify fail**

Run: `bun test tests/manifest-schema.test.ts`
Expected: 4 new tests fail (`slaude_skills` undefined on schema).

- [ ] **Step 3: Implement `slaude_skills` schema**

In `src/config/manifest-schema.ts`, add before `manifestSchema`:

```ts
export const slaudeSkillsTarget = z.object({
  git: gitUrl,
  ref: z.string().min(1),
});
export type SlaudeSkillsTarget = z.infer<typeof slaudeSkillsTarget>;
```

Update `manifestSchema`:

```ts
export const manifestSchema = z.object({
  plugins: z.array(pluginEntry).default([]),
  skills: z.array(skillEntry).default([]),
  knowledge: z.array(knowledgeEntry).default([]),
  slaude_skills: slaudeSkillsTarget.optional(),
});
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test tests/manifest-schema.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/config/manifest-schema.ts tests/manifest-schema.test.ts
git commit -m "feat(manifest): add slaude_skills top-level field"
```

---

### Task 2: Manifest schema — `slaude_knowledge` + lockfile mirror

**Files:**
- Modify: `src/config/manifest-schema.ts`
- Test: `tests/manifest-schema.test.ts`

- [ ] **Step 1: Write failing tests for `slaude_knowledge`**

Append to `tests/manifest-schema.test.ts`:

```ts
describe("manifestSchema slaude_knowledge", () => {
  test("accepts manifest without slaude_knowledge (optional)", () => {
    const r = manifestSchema.parse({});
    expect(r.slaude_knowledge).toBeUndefined();
  });

  test("accepts manifest with slaude_knowledge", () => {
    const r = manifestSchema.parse({
      slaude_knowledge: { label: "ops-wiki", git: "github:owner/wiki", ref: "main" },
    });
    expect(r.slaude_knowledge?.label).toBe("ops-wiki");
    expect(r.slaude_knowledge?.git).toBe("github:owner/wiki");
  });

  test("rejects slaude_knowledge with missing label", () => {
    expect(() => manifestSchema.parse({
      slaude_knowledge: { git: "github:owner/wiki", ref: "main" },
    })).toThrow();
  });

  test("rejects slaude_knowledge with missing git/ref", () => {
    expect(() => manifestSchema.parse({
      slaude_knowledge: { label: "wiki" },
    })).toThrow();
  });
});

describe("lockfileSchema slaude_knowledge", () => {
  test("accepts lockfile without slaude_knowledge", () => {
    const r = lockfileSchema.parse({
      version: 1,
      generated_at: "2026-05-21T00:00:00.000Z",
    });
    expect(r.slaude_knowledge).toBeUndefined();
  });

  test("accepts lockfile with slaude_knowledge raw_sha + wiki_sha", () => {
    const r = lockfileSchema.parse({
      version: 1,
      generated_at: "2026-05-21T00:00:00.000Z",
      slaude_knowledge: {
        label: "ops-wiki",
        git: "github:owner/wiki",
        ref: "main",
        raw_sha: "a".repeat(40),
        wiki_sha: "b".repeat(40),
      },
    });
    expect(r.slaude_knowledge?.raw_sha).toBe("a".repeat(40));
    expect(r.slaude_knowledge?.wiki_sha).toBe("b".repeat(40));
  });

  test("accepts slaude_skills lock with single sha", () => {
    const r = lockfileSchema.parse({
      version: 1,
      generated_at: "2026-05-21T00:00:00.000Z",
      slaude_skills: { git: "github:owner/sk", ref: "main", sha: "c".repeat(40) },
    });
    expect(r.slaude_skills?.sha).toBe("c".repeat(40));
  });
});
```

- [ ] **Step 2: Run test to verify fail**

Run: `bun test tests/manifest-schema.test.ts`
Expected: 7 new tests fail.

- [ ] **Step 3: Implement schemas**

In `src/config/manifest-schema.ts`, add:

```ts
export const slaudeKnowledgeTarget = z.object({
  label: z.string().min(1),
  git: gitUrl,
  ref: z.string().min(1),
});
export type SlaudeKnowledgeTarget = z.infer<typeof slaudeKnowledgeTarget>;
```

Extend `manifestSchema`:

```ts
export const manifestSchema = z.object({
  plugins: z.array(pluginEntry).default([]),
  skills: z.array(skillEntry).default([]),
  knowledge: z.array(knowledgeEntry).default([]),
  slaude_skills: slaudeSkillsTarget.optional(),
  slaude_knowledge: slaudeKnowledgeTarget.optional(),
});
```

Add lock shapes near other lock schemas:

```ts
const slaudeSkillsLock = z.object({
  git: z.string(),
  ref: z.string(),
  sha: z.string().length(40),
});

const slaudeKnowledgeLock = z.object({
  label: z.string().min(1),
  git: z.string(),
  ref: z.string(),
  raw_sha: z.string().length(40).optional(),
  wiki_sha: z.string().length(40).optional(),
});
```

Extend `lockfileSchema`:

```ts
export const lockfileSchema = z.object({
  version: z.literal(1),
  generated_at: z.string().datetime(),
  marketplaces: z.record(z.string(), marketplaceEntryLock).default({}),
  skills: z.record(z.string(), skillLock).default({}),
  knowledge: z.record(z.string(), knowledgeLock).default({}),
  slaude_skills: slaudeSkillsLock.optional(),
  slaude_knowledge: slaudeKnowledgeLock.optional(),
});
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test tests/manifest-schema.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/config/manifest-schema.ts tests/manifest-schema.test.ts
git commit -m "feat(manifest): add slaude_knowledge + lockfile raw_sha/wiki_sha"
```

---

### Task 3: `sync_manifest` — route skills push through `slaude_skills` (env fallback)

**Files:**
- Modify: `src/skills/sync-manifest.ts`
- Test: `tests/sync-manifest.test.ts`

- [ ] **Step 1: Write failing test**

Append to `tests/sync-manifest.test.ts`:

```ts
test("sync_manifest pushes to manifest.slaude_skills.git when set, ignoring env", async () => {
  process.env.SLAUDE_SKILLS_REPO = "https://wrong.example.com/repo.git";
  const repoRemote = await fakeBareRepo();
  const manifest = {
    plugins: [], skills: [], knowledge: [],
    slaude_skills: { git: repoRemote, ref: "main" },
  };
  writeFileSync(join(SLAUDE_HOME, "slaude.json"), JSON.stringify(manifest));
  mkdirSync(join(paths.skills, "demo"), { recursive: true });
  writeFileSync(join(paths.skills, "demo", "SKILL.md"), "---\nname: demo\ndescription: x\n---\nbody\n");

  const r = await syncManifest();
  const out = JSON.parse(r.content[0]!.text);
  expect(r.isError).toBeUndefined();
  expect(out.synced_skills).toEqual(["demo"]);
  expect(out.skills_in_git).toBe(true);

  const lock = JSON.parse(readFileSync(join(SLAUDE_HOME, "slaude.lock"), "utf8"));
  expect(lock.skills.demo.git).toBe(repoRemote);
});
```

(Assumes `fakeBareRepo()` helper from existing `tests/sync-manifest.test.ts` test setup. If absent, copy the pattern from existing `pushToRepo` tests.)

- [ ] **Step 2: Run test to verify fail**

Run: `bun test tests/sync-manifest.test.ts`
Expected: new test fails — current code routes via `env.skillsRepo()` only.

- [ ] **Step 3: Implement**

In `src/skills/sync-manifest.ts`, replace `const skillsRepo = env.skillsRepo();` with:

```ts
function resolveSkillsPushTarget(manifest: Manifest): { git: string; ref: string } | null {
  if (manifest.slaude_skills) return manifest.slaude_skills;
  const envUrl = env.skillsRepo();
  if (envUrl) return { git: envUrl, ref: "main" };
  return null;
}
```

Then in `syncManifest()`:

```ts
const target = resolveSkillsPushTarget(manifest);
// replace `if (hasNewContent && skillsRepo)` with `if (hasNewContent && target)`
// inside that branch, replace `skillsRepo` with `target.git` and `"main"` with `target.ref`
```

Update the `manifest.skills.push` / `lock.skills[s.slug]` lines to write `git: target.git, ref: target.ref` instead of `git: skillsRepo, ref: "main"`.

Update the corresponding KB push branch the same way (for now KBs continue piggybacking on this push target — Task 5 will move them to `slaude_knowledge`).

- [ ] **Step 4: Run test to verify pass**

Run: `bun test tests/sync-manifest.test.ts`
Expected: all tests pass (including existing tests that still set `SLAUDE_SKILLS_REPO`).

- [ ] **Step 5: Commit**

```bash
git add src/skills/sync-manifest.ts tests/sync-manifest.test.ts
git commit -m "feat(sync-manifest): prefer slaude_skills manifest field over env var"
```

---

### Task 4: `sync_manifest` — pull mode for read-only KBs

**Files:**
- Modify: `src/skills/sync-manifest.ts`
- Test: `tests/sync-manifest.test.ts`

- [ ] **Step 1: Write failing test**

Append to `tests/sync-manifest.test.ts`:

```ts
test("sync_manifest pulls read-only KBs to declared ref", async () => {
  const remote = await fakeBareRepoWithCommit("seed", "README.md", "# seed\n");
  const manifest = {
    plugins: [], skills: [],
    knowledge: [{ label: "ext-wiki", git: remote, ref: "main" }],
  };
  writeFileSync(join(SLAUDE_HOME, "slaude.json"), JSON.stringify(manifest));
  // simulate a prior install (stale checkout)
  const kbDir = join(paths.knowledge, "ext-wiki");
  mkdirSync(kbDir, { recursive: true });
  writeFileSync(join(kbDir, "README.md"), "# STALE\n");

  // advance the remote
  const newSha = await commitToRemote(remote, "README.md", "# fresh\n");

  const r = await syncManifest();
  const out = JSON.parse(r.content[0]!.text);
  expect(out.pulled_kbs).toEqual(["ext-wiki"]);
  expect(readFileSync(join(kbDir, "README.md"), "utf8")).toBe("# fresh\n");

  const lock = JSON.parse(readFileSync(join(SLAUDE_HOME, "slaude.lock"), "utf8"));
  expect(lock.knowledge["ext-wiki"].sha).toBe(newSha);
});
```

(Helpers `fakeBareRepoWithCommit` + `commitToRemote` may need to be added to the test fixtures — write them inline if absent. Use `execSync` against a tmp dir like the existing tests.)

- [ ] **Step 2: Run test to verify fail**

Run: `bun test tests/sync-manifest.test.ts -t "pulls read-only KBs"`
Expected: fails — no pull behavior exists.

- [ ] **Step 3: Implement**

In `src/skills/sync-manifest.ts`, add a helper:

```ts
function pullKb(label: string, git: string, ref: string): { sha: string } {
  const dir = join(paths.knowledge, label);
  const resolved = resolveGitUrl(git);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execSync(`git clone --depth 1 --branch "${ref}" "${resolved}" "${dir}"`, { stdio: "pipe" });
  const sha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
  return { sha };
}
```

Add to `syncManifest()`, before the result JSON:

```ts
const pulledKbs: string[] = [];
for (const kb of manifest.knowledge) {
  if (!kb.git || !kb.ref) continue;
  try {
    const { sha } = pullKb(kb.label, kb.git, kb.ref);
    lock.knowledge[kb.label] = { git: kb.git, ref: kb.ref, sha, ...(kb.path ? { path: kb.path } : {}) };
    pulledKbs.push(kb.label);
  } catch (e: any) {
    warnings.push(`pull ${kb.label}: ${e?.message ?? e}`);
  }
}
```

Import `paths`:

```ts
import { paths } from "../config/home";
```

(Already imported indirectly via `loader` — verify and add the direct import if missing.)

Add `pulled_kbs` to the returned JSON:

```ts
return ok(JSON.stringify({
  synced_skills: newSkills.map((s) => s.slug),
  synced_kbs: newKbs.map((kb) => kb.label),
  pulled_kbs: pulledKbs,
  warnings,
  skills_in_git: skillsInGit,
}));
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test tests/sync-manifest.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/skills/sync-manifest.ts tests/sync-manifest.test.ts
git commit -m "feat(sync-manifest): pull read-only KBs to declared ref"
```

---

### Task 5: `sync_manifest` — push writable-KB `raw/` (skip `wiki/`)

**Files:**
- Modify: `src/skills/sync-manifest.ts`
- Test: `tests/sync-manifest.test.ts`

- [ ] **Step 1: Write failing test**

Append to `tests/sync-manifest.test.ts`:

```ts
test("sync_manifest pushes writable KB raw/ but not wiki/", async () => {
  const remote = await fakeBareRepo();
  const manifest = {
    plugins: [], skills: [], knowledge: [],
    slaude_knowledge: { label: "ops-wiki", git: remote, ref: "main" },
  };
  writeFileSync(join(SLAUDE_HOME, "slaude.json"), JSON.stringify(manifest));
  const kbDir = join(paths.knowledge, "ops-wiki");
  mkdirSync(join(kbDir, "raw"), { recursive: true });
  writeFileSync(join(kbDir, "raw", "note-1.md"), "raw note\n");
  mkdirSync(join(kbDir, "wiki"), { recursive: true });
  writeFileSync(join(kbDir, "wiki", "con-foo.md"), "wiki page — should NOT be pushed\n");

  const r = await syncManifest();
  const out = JSON.parse(r.content[0]!.text);
  expect(out.synced_raw).toBe(true);

  // verify remote got raw/ but not wiki/
  const probeDir = mkdtempSync(join(tmpdir(), "probe-"));
  execSync(`git clone --depth 1 "${remote}" "${probeDir}"`, { stdio: "pipe" });
  expect(existsSync(join(probeDir, "raw", "note-1.md"))).toBe(true);
  expect(existsSync(join(probeDir, "wiki", "con-foo.md"))).toBe(false);

  const lock = JSON.parse(readFileSync(join(SLAUDE_HOME, "slaude.lock"), "utf8"));
  expect(lock.slaude_knowledge.raw_sha).toMatch(/^[0-9a-f]{40}$/);
  expect(lock.slaude_knowledge.wiki_sha).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify fail**

Run: `bun test tests/sync-manifest.test.ts -t "writable KB raw"`
Expected: fails — `synced_raw` not in output, lock has no `slaude_knowledge`.

- [ ] **Step 3: Implement**

In `src/skills/sync-manifest.ts`, add helper:

```ts
function rawDirSha(kbDir: string): string {
  // hash raw/ contents deterministically so we can short-circuit no-op pushes.
  // Use git's tree-hash via a throwaway repo for simplicity.
  const rawDir = join(kbDir, "raw");
  if (!existsSync(rawDir)) return "0".repeat(40);
  const tmp = mkdtempSync(join(tmpdir(), "slaude-rawhash-"));
  try {
    execSync("git init", { cwd: tmp, stdio: "pipe" });
    execSync(`cp -r "${rawDir}" "${join(tmp, "raw")}"`, { stdio: "pipe" });
    execSync("git add -A", { cwd: tmp, stdio: "pipe" });
    return execSync("git write-tree", { cwd: tmp, encoding: "utf8" }).trim()
      .padEnd(40, "0").slice(0, 40);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function pushKbRaw(
  repoUrl: string, ref: string, kbDir: string,
): { sha: string } {
  const resolved = resolveGitUrl(repoUrl);
  const tmp = mkdtempSync(join(tmpdir(), "slaude-kbpush-"));
  try {
    try {
      execSync(`git clone --branch "${ref}" --depth 1 "${resolved}" "${tmp}"`, { stdio: "pipe" });
    } catch {
      mkdirSync(tmp, { recursive: true });
      execSync(`git -c init.defaultBranch="${ref}" init`, { cwd: tmp, stdio: "pipe" });
      execSync(`git remote add origin "${resolved}"`, { cwd: tmp, stdio: "pipe" });
    }
    const destRaw = join(tmp, "raw");
    if (existsSync(destRaw)) rmSync(destRaw, { recursive: true, force: true });
    const srcRaw = join(kbDir, "raw");
    if (existsSync(srcRaw)) execSync(`cp -r "${srcRaw}" "${destRaw}"`, { stdio: "pipe" });
    execSync("git add -A raw", { cwd: tmp, stdio: "pipe" });
    try {
      execSync(`git -c user.name=slaude -c user.email="slaude@local" commit -m "slaude: sync raw"`, { cwd: tmp, stdio: "pipe" });
      execSync(`git push origin "${ref}"`, { cwd: tmp, stdio: "pipe" });
    } catch {
      // nothing to commit — that's fine
    }
    return { sha: execSync("git rev-parse HEAD", { cwd: tmp, encoding: "utf8" }).trim() };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
```

In `syncManifest()`, before the lockfile write:

```ts
let syncedRaw = false;
if (manifest.slaude_knowledge) {
  const skn = manifest.slaude_knowledge;
  const kbDir = join(paths.knowledge, skn.label);
  if (existsSync(kbDir)) {
    const currentRawSha = rawDirSha(kbDir);
    const prior = lock.slaude_knowledge?.raw_sha;
    if (prior !== currentRawSha) {
      try {
        const { sha } = pushKbRaw(skn.git, skn.ref, kbDir);
        lock.slaude_knowledge = {
          label: skn.label,
          git: skn.git,
          ref: skn.ref,
          raw_sha: currentRawSha,
          wiki_sha: lock.slaude_knowledge?.wiki_sha,
        };
        syncedRaw = true;
      } catch (e: any) {
        warnings.push(`push slaude_knowledge raw: ${e?.message ?? e}`);
      }
    }
  }
}
```

Add `synced_raw: syncedRaw` to the result JSON. Update the early no-op return so it also surfaces `synced_raw: false, pulled_kbs: []`.

- [ ] **Step 4: Run test to verify pass**

Run: `bun test tests/sync-manifest.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/skills/sync-manifest.ts tests/sync-manifest.test.ts
git commit -m "feat(sync-manifest): push writable-KB raw/ to slaude_knowledge, skip wiki/"
```

---

### Task 6: DB — `kb_ingest_jobs` table

**Files:**
- Modify: `src/db/schema.ts`
- Test: `tests/db.test.ts`

- [ ] **Step 1: Write failing test**

Append to `tests/db.test.ts`:

```ts
test("kb_ingest_jobs table exists with expected columns", () => {
  const cols = db.query("PRAGMA table_info(kb_ingest_jobs)").all() as Array<{ name: string }>;
  const names = cols.map((c) => c.name).sort();
  expect(names).toEqual(["heartbeat_at", "id", "label", "started_at", "status", "triggered_by"].sort());
});
```

- [ ] **Step 2: Run test to verify fail**

Run: `bun test tests/db.test.ts -t "kb_ingest_jobs"`
Expected: fails — pragma returns empty.

- [ ] **Step 3: Implement**

In `src/db/schema.ts`, extend `SCHEMA`:

```ts
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (...);
CREATE INDEX IF NOT EXISTS idx_sessions_thread ...;
CREATE TABLE IF NOT EXISTS skill_usage (...);

CREATE TABLE IF NOT EXISTS kb_ingest_jobs (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  triggered_by TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_ingest_running
  ON kb_ingest_jobs (status) WHERE status = 'running';
`;
```

(Preserve the existing `sessions` and `skill_usage` definitions — only add the new statements.)

- [ ] **Step 4: Run test to verify pass**

Run: `bun test tests/db.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts tests/db.test.ts
git commit -m "feat(db): add kb_ingest_jobs table with single-running unique index"
```

---

### Task 7: Ingest-jobs module — mutex acquire/release/heartbeat

**Files:**
- Create: `src/db/ingest-jobs.ts`
- Create: `tests/ingest-jobs.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/ingest-jobs.test.ts`:

```ts
import { describe, test, expect, beforeEach } from "bun:test";
import { db } from "../src/db/schema";
import { tryAcquire, release, heartbeat, runningJob, reapStale, STALE_AFTER_MS } from "../src/db/ingest-jobs";

beforeEach(() => {
  db.run("DELETE FROM kb_ingest_jobs");
});

describe("ingest-jobs", () => {
  test("tryAcquire succeeds when no running job", () => {
    const job = tryAcquire("ops-wiki", "U123");
    expect(job).not.toBeNull();
    expect(job!.label).toBe("ops-wiki");
    expect(job!.status).toBe("running");
  });

  test("tryAcquire fails when one already running", () => {
    tryAcquire("ops-wiki", "U123");
    const second = tryAcquire("ops-wiki", "U456");
    expect(second).toBeNull();
  });

  test("release frees the slot", () => {
    const job = tryAcquire("ops-wiki", "U123")!;
    release(job.id, "completed");
    expect(runningJob()).toBeNull();
    const next = tryAcquire("ops-wiki", "U456");
    expect(next).not.toBeNull();
  });

  test("heartbeat advances heartbeat_at", async () => {
    const job = tryAcquire("ops-wiki", "U123")!;
    const before = job.heartbeat_at;
    await new Promise((r) => setTimeout(r, 5));
    heartbeat(job.id);
    const row = runningJob()!;
    expect(row.heartbeat_at).toBeGreaterThan(before);
  });

  test("reapStale releases jobs older than STALE_AFTER_MS", () => {
    const job = tryAcquire("ops-wiki", "U123")!;
    const past = Date.now() - STALE_AFTER_MS - 1000;
    db.run("UPDATE kb_ingest_jobs SET heartbeat_at = ? WHERE id = ?", [past, job.id]);
    const reaped = reapStale();
    expect(reaped).toEqual([job.id]);
    expect(runningJob()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify fail**

Run: `bun test tests/ingest-jobs.test.ts`
Expected: fails — module does not exist.

- [ ] **Step 3: Implement**

Create `src/db/ingest-jobs.ts`:

```ts
import { db } from "./schema";

export const STALE_AFTER_MS = 10 * 60 * 1000; // 10 min

export type IngestJob = {
  id: string;
  label: string;
  status: "running" | "completed" | "failed" | "crashed";
  triggered_by: string;
  started_at: number;
  heartbeat_at: number;
};

function nowMs(): number { return Date.now(); }

function rid(): string {
  return `${nowMs().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function tryAcquire(label: string, triggeredBy: string): IngestJob | null {
  reapStale();
  const t = nowMs();
  const id = rid();
  try {
    db.run(
      `INSERT INTO kb_ingest_jobs (id, label, status, triggered_by, started_at, heartbeat_at)
       VALUES (?, ?, 'running', ?, ?, ?)`,
      [id, label, triggeredBy, t, t],
    );
  } catch {
    return null; // unique index on status='running' triggered
  }
  return { id, label, status: "running", triggered_by: triggeredBy, started_at: t, heartbeat_at: t };
}

export function heartbeat(id: string): void {
  db.run("UPDATE kb_ingest_jobs SET heartbeat_at = ? WHERE id = ? AND status = 'running'", [nowMs(), id]);
}

export function release(id: string, finalStatus: "completed" | "failed" | "crashed"): void {
  db.run("UPDATE kb_ingest_jobs SET status = ?, heartbeat_at = ? WHERE id = ?", [finalStatus, nowMs(), id]);
}

export function runningJob(): IngestJob | null {
  const row = db.query("SELECT * FROM kb_ingest_jobs WHERE status = 'running' LIMIT 1").get() as IngestJob | null;
  return row ?? null;
}

export function reapStale(): string[] {
  const cutoff = nowMs() - STALE_AFTER_MS;
  const stale = db.query("SELECT id FROM kb_ingest_jobs WHERE status = 'running' AND heartbeat_at < ?").all([cutoff]) as Array<{ id: string }>;
  for (const r of stale) {
    db.run("UPDATE kb_ingest_jobs SET status = 'crashed' WHERE id = ?", [r.id]);
  }
  return stale.map((r) => r.id);
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test tests/ingest-jobs.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/db/ingest-jobs.ts tests/ingest-jobs.test.ts
git commit -m "feat(db): ingest-jobs mutex (acquire/release/heartbeat/reapStale)"
```

---

### Task 8: Ingest engine — sub-query driver + push

**Files:**
- Create: `src/knowledge/ingest.ts`
- Create: `tests/ingest.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/ingest.test.ts`:

```ts
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { paths, SLAUDE_HOME } from "../src/config/home";
import { db } from "../src/db/schema";
import * as ingest from "../src/knowledge/ingest";

beforeEach(() => {
  db.run("DELETE FROM kb_ingest_jobs");
  if (existsSync(paths.knowledge)) rmSync(paths.knowledge, { recursive: true, force: true });
  mkdirSync(paths.knowledge, { recursive: true });
});

describe("ingest", () => {
  test("rejects when no slaude_knowledge declared in manifest", async () => {
    writeFileSync(join(SLAUDE_HOME, "slaude.json"), JSON.stringify({ plugins: [], skills: [], knowledge: [] }));
    const r = await ingest.run({ triggeredBy: "U123" });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/slaude_knowledge/i);
  });

  test("rejects when another ingest is running", async () => {
    writeFileSync(join(SLAUDE_HOME, "slaude.json"), JSON.stringify({
      slaude_knowledge: { label: "wiki", git: "x", ref: "main" },
    }));
    mkdirSync(join(paths.knowledge, "wiki"), { recursive: true });
    db.run("INSERT INTO kb_ingest_jobs VALUES ('existing', 'wiki', 'running', 'U999', ?, ?)", [Date.now(), Date.now()]);
    const r = await ingest.run({ triggeredBy: "U123" });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/already running/i);
  });

  test("happy path: acquires lock, runs sub-query, releases lock", async () => {
    writeFileSync(join(SLAUDE_HOME, "slaude.json"), JSON.stringify({
      slaude_knowledge: { label: "wiki", git: "https://example.com/wiki.git", ref: "main" },
    }));
    const kbDir = join(paths.knowledge, "wiki");
    mkdirSync(join(kbDir, "raw"), { recursive: true });
    writeFileSync(join(kbDir, "README.md"), "# wiki schema\nIngest workflow: read raw/, write to wiki/.\n");
    writeFileSync(join(kbDir, "raw", "note-1.md"), "captured note\n");

    const subqueryMock = mock(async () => ({ turns: 3, pages_changed: 2 }));
    const pushMock = mock(async () => ({ sha: "f".repeat(40) }));
    const r = await ingest.run({
      triggeredBy: "U123",
      _runSubQuery: subqueryMock,
      _pushWiki: pushMock,
    });
    expect(r.ok).toBe(true);
    expect(subqueryMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(1);

    const remaining = db.query("SELECT status FROM kb_ingest_jobs WHERE status='running'").all();
    expect(remaining.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify fail**

Run: `bun test tests/ingest.test.ts`
Expected: fails — module does not exist.

- [ ] **Step 3: Implement**

Create `src/knowledge/ingest.ts`:

```ts
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { paths, SLAUDE_HOME } from "../config/home";
import { manifestSchema, lockfileSchema, resolveGitUrl, type Manifest, type Lockfile } from "../config/manifest-schema";
import { tryAcquire, release, heartbeat } from "../db/ingest-jobs";
import { soulSystemBlock } from "../soul/loader";
import { env } from "../config/env";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { writeFileSync } from "node:fs";

export type IngestResult =
  | { ok: true; jobId: string; summary: string }
  | { ok: false; reason: string };

export type IngestOptions = {
  triggeredBy: string;
  /** Injection point for tests — defaults to the real SDK driver. */
  _runSubQuery?: (args: { kbDir: string; readme: string; rawFiles: string[] }) => Promise<{ turns: number; pages_changed: number }>;
  /** Injection point for tests — defaults to git push. */
  _pushWiki?: (args: { repoUrl: string; ref: string; kbDir: string }) => Promise<{ sha: string }>;
};

export async function run(opts: IngestOptions): Promise<IngestResult> {
  const manifestPath = join(SLAUDE_HOME, "slaude.json");
  if (!existsSync(manifestPath)) return { ok: false, reason: "no slaude.json; cannot determine slaude_knowledge target" };
  let manifest: Manifest;
  try {
    manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  } catch (e: any) {
    return { ok: false, reason: `invalid slaude.json: ${e?.message ?? e}` };
  }
  if (!manifest.slaude_knowledge) {
    return { ok: false, reason: "manifest.slaude_knowledge not set; no writable KB to ingest" };
  }
  const { label, git, ref } = manifest.slaude_knowledge;
  const kbDir = join(paths.knowledge, label);
  if (!existsSync(kbDir)) return { ok: false, reason: `KB dir ${kbDir} does not exist (run slaude install or sync_manifest first)` };

  const job = tryAcquire(label, opts.triggeredBy);
  if (!job) return { ok: false, reason: "another ingest is already running" };

  const heartbeatTimer = setInterval(() => heartbeat(job.id), 30_000);
  try {
    const readme = readFileSync(join(kbDir, "README.md"), "utf8");
    const rawDir = join(kbDir, "raw");
    const rawFiles = existsSync(rawDir)
      ? (await import("node:fs")).readdirSync(rawDir).filter((f) => f.endsWith(".md"))
      : [];

    const runFn = opts._runSubQuery ?? defaultRunSubQuery;
    const subResult = await runFn({ kbDir, readme, rawFiles });

    const pushFn = opts._pushWiki ?? defaultPushWiki;
    const pushResult = await pushFn({ repoUrl: git, ref, kbDir });

    // update lockfile with wiki_sha
    const lockPath = join(SLAUDE_HOME, "slaude.lock");
    let lock: Lockfile = { version: 1, generated_at: new Date().toISOString(), marketplaces: {}, skills: {}, knowledge: {} };
    if (existsSync(lockPath)) {
      try { lock = lockfileSchema.parse(JSON.parse(readFileSync(lockPath, "utf8"))); } catch { /* keep default */ }
    }
    lock.slaude_knowledge = {
      label, git, ref,
      raw_sha: lock.slaude_knowledge?.raw_sha,
      wiki_sha: pushResult.sha,
    };
    lock.generated_at = new Date().toISOString();
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n", "utf8");

    release(job.id, "completed");
    return { ok: true, jobId: job.id, summary: `ingested ${rawFiles.length} raw file(s); ${subResult.pages_changed} wiki pages changed; pushed ${pushResult.sha.slice(0, 7)}` };
  } catch (e: any) {
    release(job.id, "failed");
    return { ok: false, reason: e?.message ?? String(e) };
  } finally {
    clearInterval(heartbeatTimer);
  }
}

async function defaultRunSubQuery(args: { kbDir: string; readme: string; rawFiles: string[] }): Promise<{ turns: number; pages_changed: number }> {
  const systemPrompt = [
    soulSystemBlock(),
    "\n\n<ingest-mode>",
    `You are running an ingest pass against the writable knowledge base mounted at ${args.kbDir}.`,
    "The KB's schema is below. Follow it. Read raw/ entries that are not yet reflected in wiki/, update wiki/ pages, append to wiki/log.md, and stop when done.",
    "Do NOT call mcp__slaude_slack__*. Do NOT call mcp__slaude_skills__write_skill or sync_manifest. Use Read/Write/Edit/Bash directly.",
    "</ingest-mode>",
    "\n\n<kb-schema source=\"README.md\">",
    args.readme,
    "</kb-schema>",
  ].join("");
  const initialPrompt = `Ingest pass requested. Raw files present: ${args.rawFiles.join(", ") || "(none)"}.`;

  let turns = 0;
  let pagesChanged = 0;
  const sdk = sdkQuery({
    prompt: (async function* () { yield { type: "user", message: { role: "user", content: initialPrompt } }; })(),
    options: {
      systemPrompt,
      cwd: args.kbDir,
      model: env.model() || undefined,
      permissionMode: "bypassPermissions", // ingest is gated upstream by /ingest auth
    },
  });
  for await (const msg of sdk) {
    if ((msg as any).type === "result") turns += 1;
    if ((msg as any).type === "assistant") {
      const toolUses = ((msg as any).message?.content ?? []).filter((b: any) => b.type === "tool_use" && (b.name === "Write" || b.name === "Edit"));
      pagesChanged += toolUses.length;
    }
  }
  return { turns, pages_changed: pagesChanged };
}

async function defaultPushWiki(args: { repoUrl: string; ref: string; kbDir: string }): Promise<{ sha: string }> {
  const resolved = resolveGitUrl(args.repoUrl);
  const tmp = mkdtempSync(join(tmpdir(), "slaude-ingest-push-"));
  try {
    try {
      execSync(`git clone --branch "${args.ref}" --depth 1 "${resolved}" "${tmp}"`, { stdio: "pipe" });
    } catch {
      mkdirSync(tmp, { recursive: true });
      execSync(`git -c init.defaultBranch="${args.ref}" init`, { cwd: tmp, stdio: "pipe" });
      execSync(`git remote add origin "${resolved}"`, { cwd: tmp, stdio: "pipe" });
    }
    for (const sub of ["raw", "wiki"]) {
      const dest = join(tmp, sub);
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
      const src = join(args.kbDir, sub);
      if (existsSync(src)) execSync(`cp -r "${src}" "${dest}"`, { stdio: "pipe" });
    }
    execSync("git add -A", { cwd: tmp, stdio: "pipe" });
    try {
      execSync(`git -c user.name=slaude -c user.email="slaude@local" commit -m "slaude: ingest"`, { cwd: tmp, stdio: "pipe" });
      execSync(`git push origin "${args.ref}"`, { cwd: tmp, stdio: "pipe" });
    } catch {
      // nothing to commit
    }
    return { sha: execSync("git rev-parse HEAD", { cwd: tmp, encoding: "utf8" }).trim() };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test tests/ingest.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/knowledge/ingest.ts tests/ingest.test.ts
git commit -m "feat(knowledge): /ingest engine — sub-query driver + git push"
```

---

### Task 9: `/ingest` slash command parsing

**Files:**
- Modify: `src/gateway/slack/commands.ts`
- Test: `tests/commands.test.ts`

- [ ] **Step 1: Write failing test**

Append to `tests/commands.test.ts`:

```ts
test("parses /ingest with no args", () => {
  expect(parseSlashCommand("/ingest")).toEqual({ kind: "ingest" });
});

test("parses /ingest with whitespace, ignores junk args", () => {
  expect(parseSlashCommand("/ingest  whatever")).toEqual({ kind: "ingest" });
});

test("/help mentions /ingest", () => {
  expect(helpText()).toContain("/ingest");
});
```

- [ ] **Step 2: Run test to verify fail**

Run: `bun test tests/commands.test.ts`
Expected: fails — kind `ingest` not in `SlashHit`.

- [ ] **Step 3: Implement**

In `src/gateway/slack/commands.ts`:

Add to the `SlashHit` union:

```ts
export type SlashHit =
  | { kind: "mode"; mode: PermissionMode }
  | { kind: "mode-help" }
  | { kind: "abort" }
  | { kind: "help" }
  | { kind: "ingest" };
```

Inside `parseSlashCommand`, before the trailing `return null`:

```ts
if (cmd === "ingest") {
  return { kind: "ingest" };
}
```

Extend `helpText()`:

```ts
return [
  "*slaude commands*",
  "`/mode <name>` — set tool-permission mode (per session/thread)",
  modes,
  "`/abort` — cancel the current turn",
  "`/ingest` — synthesize raw/ → wiki/ in the writable KB (manager/approver only)",
  "`/help` — this message",
].join("\n");
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test tests/commands.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/slack/commands.ts tests/commands.test.ts
git commit -m "feat(slack): parse /ingest slash command"
```

---

### Task 10: `/ingest` auth gate (manager + approvers)

**Files:**
- Create: `src/gateway/slack/ingest-auth.ts`
- Create: `tests/ingest-auth.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/ingest-auth.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { canTriggerIngest } from "../src/gateway/slack/ingest-auth";

describe("canTriggerIngest", () => {
  test("allows manager", () => {
    const soul = { manager: { userId: "U_MGR" }, backupManager: null, approvers: [] };
    expect(canTriggerIngest("U_MGR", soul as any)).toBe(true);
  });

  test("allows backup manager", () => {
    const soul = { manager: { userId: "U_MGR" }, backupManager: { userId: "U_BKP" }, approvers: [] };
    expect(canTriggerIngest("U_BKP", soul as any)).toBe(true);
  });

  test("allows approver", () => {
    const soul = {
      manager: { userId: "U_MGR" },
      backupManager: null,
      approvers: [{ userId: "U_APP", scope: "anything" }],
    };
    expect(canTriggerIngest("U_APP", soul as any)).toBe(true);
  });

  test("denies anyone else", () => {
    const soul = { manager: { userId: "U_MGR" }, backupManager: null, approvers: [] };
    expect(canTriggerIngest("U_RANDOM", soul as any)).toBe(false);
  });

  test("denies when soul has no manager", () => {
    const soul = { manager: null, backupManager: null, approvers: [] };
    expect(canTriggerIngest("U_ANY", soul as any)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify fail**

Run: `bun test tests/ingest-auth.test.ts`
Expected: fails — module doesn't exist.

- [ ] **Step 3: Implement**

Create `src/gateway/slack/ingest-auth.ts`:

```ts
import type { SoulData } from "../../soul/data";

export function canTriggerIngest(userId: string, soul: SoulData): boolean {
  if (soul.manager?.userId === userId) return true;
  if (soul.backupManager?.userId === userId) return true;
  if (soul.approvers?.some((a) => a.userId === userId)) return true;
  return false;
}
```

(If `SoulData`'s exact field path differs, adjust to match `src/soul/data.ts`. The shape above tracks the schema as documented in CLAUDE.md.)

- [ ] **Step 4: Run test to verify pass**

Run: `bun test tests/ingest-auth.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/slack/ingest-auth.ts tests/ingest-auth.test.ts
git commit -m "feat(slack): canTriggerIngest auth gate (manager/backup/approvers)"
```

---

### Task 11: Wire `/ingest` into Slack adapter

**Files:**
- Modify: `src/gateway/slack/adapter.ts`

- [ ] **Step 1: Add imports**

In `src/gateway/slack/adapter.ts`, add to the import block:

```ts
import { canTriggerIngest } from "./ingest-auth";
import * as kbIngest from "../../knowledge/ingest";
```

- [ ] **Step 2: Add /ingest branch to slash handler**

Inside the `if (slash) { ... }` block (after the `abort` branch, before `}`):

```ts
if (slash.kind === "ingest") {
  const soul = soulData();
  if (!canTriggerIngest(userId, soul)) {
    await reply("not authorized to trigger /ingest — manager or approver only");
    return;
  }
  await reply(":hourglass_flowing_sand: ingest started…");
  const result = await kbIngest.run({ triggeredBy: userId });
  if (result.ok) {
    await reply(`:white_check_mark: ingest done — ${result.summary}`);
  } else {
    await reply(`:x: ingest failed: ${result.reason}`);
  }
  return;
}
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck` (or `bunx tsc --noEmit` if no script).
Expected: no new errors.

- [ ] **Step 4: Run full test suite**

Run: `bun test`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/slack/adapter.ts
git commit -m "feat(slack): wire /ingest to knowledge.ingest.run with auth gate"
```

---

### Task 12: Soul baseline — raw/ vs wiki/ discipline

**Files:**
- Modify: `src/soul/loader.ts`
- Test: `tests/soul.test.ts`

- [ ] **Step 1: Write failing test**

Append to `tests/soul.test.ts` (find an existing describe block for the baseline content, or add one):

```ts
test("baseline mentions raw/ during normal sessions and wiki/ during ingest", () => {
  const block = soulSystemBlock();
  expect(block).toMatch(/raw\//);
  expect(block).toMatch(/wiki\//);
  expect(block).toMatch(/\/ingest/i);
});
```

- [ ] **Step 2: Run test to verify fail**

Run: `bun test tests/soul.test.ts -t "raw/ during normal"`
Expected: fails — current baseline lacks those terms.

- [ ] **Step 3: Implement**

In `src/soul/loader.ts`, replace the existing "Knowledge bases" / "create and evolve KBs at runtime" block with:

```ts
## Knowledge bases (writable raw/, on-demand ingest)
- Read KBs anytime via \`mcp__slaude_kb__{list_kbs, open_kb}\` plus
  \`Read\`/\`Grep\`/\`Glob\`. Reach for them whenever the answer plausibly
  lives in operator-curated reference material.
- One KB in this deploy is **writable** (declared in slaude.json as
  \`slaude_knowledge\`). During normal Slack turns you may only write
  into \`~/.slaude/knowledge/<label>/raw/\` (use \`Write\`/\`Bash\`).
  NEVER write into \`wiki/\` during a normal turn — \`wiki/\` is owned
  by the ingest workflow.
- After dropping new \`raw/\` material, call \`sync_manifest\` (with
  approval) so the captured material is pushed to git and survives a
  redeploy even before ingest fires. Batch logically — don't sync after
  every single file.
- To synthesise \`raw/\` into \`wiki/\`, the manager or an approver runs
  \`/ingest\` in any thread. That triggers a dedicated background pass
  (separate sub-query, separate system prompt) which reads \`raw/\`,
  updates \`wiki/\`, and pushes the KB. You do NOT trigger ingest from
  inside a normal turn.
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test tests/soul.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/soul/loader.ts tests/soul.test.ts
git commit -m "docs(soul): baseline split raw/ writes (normal turns) vs wiki/ (ingest)"
```

---

### Task 13: README + CLAUDE.md docs + manifest example

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: README — `slaude.json` shape update**

Find the Dependency-manifest section in `README.md`. Update the example `slaude.json` to include the two new fields:

```jsonc
{
  "plugins": [...],
  "skills": [
    { "git": "github:owner/some-skill", "ref": "v1.0.0" }
  ],
  "knowledge": [
    { "label": "ext-runbooks", "git": "github:owner/runbooks", "ref": "main" }
  ],
  "slaude_skills": {
    "git": "github:owner/my-slaude-skills",
    "ref": "main"
  },
  "slaude_knowledge": {
    "label": "ops-wiki",
    "git": "github:owner/ops-wiki",
    "ref": "main"
  }
}
```

Add a short prose paragraph after the table:

> **Writable surfaces.** `slaude_skills` is the git repo where the agent pushes runtime-authored skills via `sync_manifest`. `slaude_knowledge` is the *single* writable knowledge base — the agent writes captured material into `raw/` from normal Slack turns; the manager or an approver runs `/ingest` to synthesise `raw/` into `wiki/` and push. Everything in `skills[]` and `knowledge[]` is strictly read-only (pulled on `sync_manifest`).

Add a `/ingest` row to the Slack-commands docs (if one exists):

```
`/ingest` — synthesize raw/ → wiki/ in the writable KB (manager/approver only)
```

- [ ] **Step 2: CLAUDE.md — findings log**

Append under a new dated heading (or extend May 21):

```markdown
### May 21, 2026 (Writable KB + /ingest)
- Manifest gains two top-level fields: `slaude_skills` (push target for runtime-authored skills) and `slaude_knowledge` (single writable KB target). `skills[]` / `knowledge[]` are now strictly read-only; `sync_manifest` push-or-pulls them accordingly. `SLAUDE_SKILLS_REPO` env var kept as fallback for back-compat.
- `/ingest` slash command (manager + approvers only) runs a dedicated SDK sub-query against `~/.slaude/knowledge/<label>/` with the KB's README.md as schema. The sub-query reads `raw/`, updates `wiki/`, and pushes at end. No Slack output during the sub-query (no `mcp__slaude_slack__*` tools surfaced; `permissionMode: bypassPermissions` since gate is upstream at `/ingest`).
- Lock file gains `slaude_knowledge.raw_sha` + `slaude_knowledge.wiki_sha` (split). Normal `sync_manifest` calls push only `raw/`; ingest pushes both. Lets us detect "raw captured but un-ingested" state via `raw_sha > wiki_sha`.
- Mutex: sqlite `kb_ingest_jobs` table with UNIQUE partial index on `status='running'` — at most one ingest at a time. Heartbeat every 30s; stale jobs (no heartbeat for 10min) auto-marked `crashed` on next `tryAcquire` call.
- Crash policy: on next `/ingest`, stale-reap promotes any old `running` job to `crashed`. No branch/stash gymnastics — operator sees the failure surface and re-runs.
```

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: slaude_skills + slaude_knowledge manifest fields, /ingest"
```

---

## Final verification

- [ ] Run full test suite: `bun test`
- [ ] Run typecheck: `bunx tsc --noEmit`
- [ ] Coverage threshold: confirm `bun test --coverage` still passes the 0.97 line / 0.80 func threshold in `bunfig.toml`.
- [ ] Manual smoke (optional, requires real Slack workspace):
  1. Add `slaude_knowledge` to `~/.slaude/slaude.json` pointing at an empty test repo.
  2. `slaude install`.
  3. DM agent: "drop this thread summary into raw — call it slack-thread-2026-05-21.md". Agent writes via Write tool.
  4. DM `sync_manifest` request → confirm raw/ pushed.
  5. DM `/ingest` as manager → confirm sub-query runs and wiki/ + log.md updates appear on remote.

## Self-Review Notes

- **Spec coverage:** Manifest fields (Tasks 1–2), bidirectional sync_manifest (Tasks 3–5), mutex (Tasks 6–7), ingest engine (Task 8), slash command (Tasks 9, 11), auth (Task 10), soul (Task 12), docs (Task 13). All locked decisions covered.
- **Type consistency:** `slaude_skills` / `slaude_knowledge` use `snake_case` everywhere (JSON-natural and matches existing `skills[]` / `knowledge[]`). `raw_sha` / `wiki_sha` snake_case in JSON, camelCase only when bound to TS locals.
- **Open assumption:** `src/soul/data.ts:SoulDataSchema` is assumed to expose `manager`, `backupManager`, `approvers` per CLAUDE.md findings — verify shape on Task 10 and adjust imports if names differ.
