import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  mkdtempSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SLAUDE_HOME, paths } from "../config/home";
import {
  manifestSchema,
  lockfileSchema,
  resolveGitUrl,
  resolveSkillSlug,
  type Manifest,
  type Lockfile,
} from "../config/manifest-schema";
import { discoverSkills } from "./loader";
import { loadKbs, clearKbCache } from "../knowledge/loader";
import { env } from "../config/env";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

export function pushToRepo(
  repoUrl: string,
  skills: { slug: string; dir: string }[],
  kbs: { label: string; dir: string }[] = [],
): { sha: string } {
  const resolvedUrl = resolveGitUrl(repoUrl);
  const tempDir = mkdtempSync(join(tmpdir(), "slaude-sync-"));
  try {
    try {
      execSync(`git clone --depth 1 "${resolvedUrl}" "${tempDir}"`, { stdio: "pipe" });
    } catch {
      mkdirSync(tempDir, { recursive: true });
      execSync("git -c init.defaultBranch=main init", { cwd: tempDir, stdio: "pipe" });
      execSync(`git remote add origin "${resolvedUrl}"`, { cwd: tempDir, stdio: "pipe" });
    }
    execSync("git checkout --orphan main 2>/dev/null; git branch -M main 2>/dev/null || true", { cwd: tempDir, stdio: "pipe" });
    for (const { slug, dir } of skills) {
      const destDir = join(tempDir, slug);
      mkdirSync(destDir, { recursive: true });
      for (const file of readdirSync(dir)) {
        const src = join(dir, file);
        const dest = join(destDir, file);
        if (statSync(src).isDirectory()) {
          execSync(`cp -r "${src}" "${dest}"`, { stdio: "pipe" });
        } else {
          copyFileSync(src, dest);
        }
      }
    }

    for (const { label, dir } of kbs) {
      const destDir = join(tempDir, "knowledge", label);
      mkdirSync(destDir, { recursive: true });
      for (const file of readdirSync(dir)) {
        const src = join(dir, file);
        const dest = join(destDir, file);
        if (statSync(src).isDirectory()) {
          execSync(`cp -r "${src}" "${dest}"`, { stdio: "pipe" });
        } else {
          copyFileSync(src, dest);
        }
      }
    }

    execSync("git add -A", { cwd: tempDir, stdio: "pipe" });
    const parts: string[] = [];
    if (skills.length > 0) parts.push(`skills ${skills.map((s) => s.slug).join(", ")}`);
    if (kbs.length > 0) parts.push(`kbs ${kbs.map((k) => k.label).join(", ")}`);
    execSync(`git -c user.name=slaude -c user.email="slaude@local" commit -m "slaude: sync ${parts.join("; ")}"`, { cwd: tempDir, stdio: "pipe" });
    execSync("git push origin HEAD", { cwd: tempDir, stdio: "pipe" });
    return { sha: execSync("git rev-parse HEAD", { cwd: tempDir, encoding: "utf8" }).trim() };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// Keep old name for backward compat in tests
export const pushSkillsToRepo = pushToRepo;

function resolveSkillsPushTarget(manifest: Manifest): { git: string; ref: string } | null {
  if (manifest.slaude_skills) return manifest.slaude_skills;
  const envUrl = env.skillsRepo();
  if (envUrl) return { git: envUrl, ref: "main" };
  return null;
}

function pullKb(label: string, git: string, ref: string): { sha: string } {
  const dir = join(paths.knowledge, label);
  const resolved = resolveGitUrl(git);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execSync(`git clone --depth 1 --branch "${ref}" "${resolved}" "${dir}"`, { stdio: "pipe" });
  const sha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
  return { sha };
}

function rawDirSha(kbDir: string): string {
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
    execSync(`git checkout --orphan "${ref}" 2>/dev/null; git branch -M "${ref}" 2>/dev/null || true`, { cwd: tmp, stdio: "pipe" });
    const destRaw = join(tmp, "raw");
    if (existsSync(destRaw)) rmSync(destRaw, { recursive: true, force: true });
    const srcRaw = join(kbDir, "raw");
    if (existsSync(srcRaw)) execSync(`cp -r "${srcRaw}" "${destRaw}"`, { stdio: "pipe" });
    execSync("git add -A raw", { cwd: tmp, stdio: "pipe" });
    try {
      execSync(`git -c user.name=slaude -c user.email="slaude@local" commit -m "slaude: sync raw"`, { cwd: tmp, stdio: "pipe" });
      execSync("git push origin HEAD", { cwd: tmp, stdio: "pipe" });
    } catch {
      // nothing to commit — that's fine
    }
    return { sha: execSync("git rev-parse HEAD", { cwd: tmp, encoding: "utf8" }).trim() };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function syncManifest(): Promise<ToolResult> {
  const manifestPath = join(SLAUDE_HOME, "slaude.json");
  const lockPath = join(SLAUDE_HOME, "slaude.lock");

  let manifest: Manifest;
  try {
    if (existsSync(manifestPath)) {
      manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
    } else {
      manifest = { plugins: [], skills: [], knowledge: [] };
    }
  } catch (e: any) {
    return err(`invalid slaude.json: ${e?.message ?? e}`);
  }

  let lock: Lockfile;
  try {
    if (existsSync(lockPath)) {
      lock = lockfileSchema.parse(JSON.parse(readFileSync(lockPath, "utf8")));
    } else {
      lock = { version: 1, generated_at: new Date().toISOString(), marketplaces: {}, skills: {}, knowledge: {} };
    }
  } catch {
    lock = { version: 1, generated_at: new Date().toISOString(), marketplaces: {}, skills: {}, knowledge: {} };
  }

  const registeredSlugs = new Set(manifest.skills.map((s) => resolveSkillSlug(s)).filter(Boolean));
  const registeredKbLabels = new Set(manifest.knowledge.map((k) => k.label));

  const skills = discoverSkills();
  clearKbCache();
  const kbs = loadKbs();

  const newSkills = skills.filter((s) => !registeredSlugs.has(s.slug));
  const newKbs = kbs.filter((kb) => !registeredKbLabels.has(kb.label));

  const pulledKbs: string[] = [];
  const warnings: string[] = [];
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

  if (newSkills.length === 0 && newKbs.length === 0) {
    lock.generated_at = new Date().toISOString();
    const lockTmp = lockPath + ".tmp";
    writeFileSync(lockTmp, JSON.stringify(lock, null, 2) + "\n", "utf8");
    renameSync(lockTmp, lockPath);
    return ok(JSON.stringify({ synced_skills: [], synced_kbs: [], pulled_kbs: pulledKbs, synced_raw: syncedRaw, warnings, skills_in_git: false }));
  }
  let skillsInGit = false;

  const target = resolveSkillsPushTarget(manifest);
  const hasNewContent = newSkills.length > 0 || newKbs.length > 0;

  if (hasNewContent && target) {
    try {
      const { sha } = pushToRepo(
        target.git,
        newSkills.map((s) => ({ slug: s.slug, dir: s.dir })),
        newKbs.map((kb) => ({ label: kb.label, dir: kb.path })),
      );
      for (const s of newSkills) {
        manifest.skills.push({ git: target.git, ref: target.ref, slug: s.slug, path: s.slug });
        lock.skills[s.slug] = { git: target.git, ref: target.ref, sha, path: s.slug };
      }
      for (const kb of newKbs) {
        const kbPath = `knowledge/${kb.label}`;
        manifest.knowledge.push({ label: kb.label, git: target.git, ref: target.ref, path: kbPath });
        lock.knowledge[kb.label] = { git: target.git, ref: target.ref, sha, path: kbPath };
      }
      skillsInGit = true;
    } catch (e: any) {
      warnings.push(`git push failed (${e?.message ?? e}) — skills/KBs recorded as local entries`);
      for (const s of newSkills) {
        manifest.skills.push({ slug: s.slug });
      }
      for (const kb of newKbs) {
        manifest.knowledge.push({ label: kb.label });
      }
    }
  } else {
    if (newSkills.length > 0 && !target) {
      warnings.push("skills push target not set — skills recorded as local-only entries (survive on PVC only)");
    }
    if (newKbs.length > 0 && !target) {
      warnings.push("skills push target not set — KBs recorded as local-only entries (survive on PVC only)");
    }
    for (const s of newSkills) {
      manifest.skills.push({ slug: s.slug });
    }
    for (const kb of newKbs) {
      manifest.knowledge.push({ label: kb.label });
    }
  }

  lock.generated_at = new Date().toISOString();
  const manifestTmp = manifestPath + ".tmp";
  const lockTmp = lockPath + ".tmp";
  writeFileSync(manifestTmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  writeFileSync(lockTmp, JSON.stringify(lock, null, 2) + "\n", "utf8");
  renameSync(manifestTmp, manifestPath);
  renameSync(lockTmp, lockPath);

  return ok(JSON.stringify({
    synced_skills: newSkills.map((s) => s.slug),
    synced_kbs: newKbs.map((kb) => kb.label),
    pulled_kbs: pulledKbs,
    synced_raw: syncedRaw,
    warnings,
    skills_in_git: skillsInGit,
  }));
}
