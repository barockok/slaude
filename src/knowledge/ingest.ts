import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { paths, SLAUDE_HOME } from "../config/home";
import { manifestSchema, lockfileSchema, resolveGitUrl, type Manifest, type Lockfile } from "../config/manifest-schema";
import { tryAcquire, release, heartbeat } from "../db/ingest-jobs";
import { soulSystemBlock } from "../soul/loader";
import { env } from "../config/env";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

export type IngestResult = {
  ok: boolean;
  jobId?: string;
  summary?: string;
  reason?: string;
};

export type IngestOptions = {
  triggeredBy: string;
  _runSubQuery?: (args: { kbDir: string; readme: string; rawFiles: string[] }) => Promise<{ turns: number; pages_changed: number }>;
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
      ? readdirSync(rawDir).filter((f) => f.endsWith(".md"))
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

export async function defaultRunSubQuery(
  args: { kbDir: string; readme: string; rawFiles: string[] },
  _query = sdkQuery,
): Promise<{ turns: number; pages_changed: number }> {
  const systemPrompt = [
    soulSystemBlock(),
    "\n\n<ingest-mode>",
    `You are running an ingest pass against the writable knowledge base mounted at ${args.kbDir}.`,
    "The KB's schema is below. Follow it. Read raw/ entries that are not yet reflected in wiki/, update wiki/ pages, append to wiki/log.md, and stop when done.",
    "Do NOT call mcp__slaude_surface__* or mcp__slaude_slack__*. Do NOT call mcp__slaude_skills__write_skill or sync_manifest. Use Read/Write/Edit/Bash directly.",
    "</ingest-mode>",
    "\n\n<kb-schema source=\"README.md\">",
    args.readme,
    "</kb-schema>",
  ].join("\n");
  const initialPrompt = `Ingest pass requested. Raw files present: ${args.rawFiles.join(", ") || "(none)"}.`;

  let turns = 0;
  let pagesChanged = 0;
  const sdk = _query({
    prompt: (async function* () { yield { type: "user" as const, message: { role: "user" as const, content: initialPrompt }, parent_tool_use_id: null }; })() as any,
    options: {
      systemPrompt,
      cwd: args.kbDir,
      model: env.model() || undefined,
      permissionMode: "bypassPermissions",
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
    execSync(`git checkout --orphan "${args.ref}" 2>/dev/null; git branch -M "${args.ref}" 2>/dev/null || true`, { cwd: tmp, stdio: "pipe" });
    for (const sub of ["raw", "wiki"]) {
      const dest = join(tmp, sub);
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
      const src = join(args.kbDir, sub);
      if (existsSync(src)) execSync(`cp -r "${src}" "${dest}"`, { stdio: "pipe" });
    }
    execSync("git add -A", { cwd: tmp, stdio: "pipe" });
    try {
      execSync(`git -c user.name=slaude -c user.email="slaude@local" commit -m "slaude: ingest"`, { cwd: tmp, stdio: "pipe" });
      execSync("git push origin HEAD", { cwd: tmp, stdio: "pipe" });
    } catch {
      // nothing to commit
    }
    return { sha: execSync("git rev-parse HEAD", { cwd: tmp, encoding: "utf8" }).trim() };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
