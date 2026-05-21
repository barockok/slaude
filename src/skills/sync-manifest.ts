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
import { SLAUDE_HOME } from "../config/home";
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
    execSync("git push origin main", { cwd: tempDir, stdio: "pipe" });
    return { sha: execSync("git rev-parse HEAD", { cwd: tempDir, encoding: "utf8" }).trim() };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// Keep old name for backward compat in tests
export const pushSkillsToRepo = pushToRepo;

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

  if (newSkills.length === 0 && newKbs.length === 0) {
    return ok(JSON.stringify({ synced_skills: [], synced_kbs: [], warnings: [], skills_in_git: false }));
  }

  const warnings: string[] = [];
  let skillsInGit = false;

  const skillsRepo = env.skillsRepo();
  const hasNewContent = newSkills.length > 0 || newKbs.length > 0;

  if (hasNewContent && skillsRepo) {
    try {
      const { sha } = pushToRepo(
        skillsRepo,
        newSkills.map((s) => ({ slug: s.slug, dir: s.dir })),
        newKbs.map((kb) => ({ label: kb.label, dir: kb.path })),
      );
      for (const s of newSkills) {
        manifest.skills.push({ git: skillsRepo, ref: "main", slug: s.slug, path: s.slug });
        lock.skills[s.slug] = { git: skillsRepo, ref: "main", sha, path: s.slug };
      }
      for (const kb of newKbs) {
        const kbPath = `knowledge/${kb.label}`;
        manifest.knowledge.push({ label: kb.label, git: skillsRepo, ref: "main", path: kbPath });
        lock.knowledge[kb.label] = { git: skillsRepo, ref: "main", sha, path: kbPath };
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
    if (newSkills.length > 0 && !skillsRepo) {
      warnings.push("SLAUDE_SKILLS_REPO not set — skills recorded as local-only entries (survive on PVC only)");
    }
    if (newKbs.length > 0 && !skillsRepo) {
      warnings.push("SLAUDE_SKILLS_REPO not set — KBs recorded as local-only entries (survive on PVC only)");
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
    warnings,
    skills_in_git: skillsInGit,
  }));
}
