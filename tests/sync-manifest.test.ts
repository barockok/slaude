import { describe, expect, test, beforeEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { SLAUDE_HOME, paths, ensureHome } from "../src/config/home";
import { syncManifest, pushSkillsToRepo, pushToRepo } from "../src/skills/sync-manifest";
import { skillOps } from "../src/skills/mcp-tools";
import { clearKbCache } from "../src/knowledge/loader";
import { manifestSchema, lockfileSchema } from "../src/config/manifest-schema";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

function seedKb(label: string, readme: string) {
  const dir = join(paths.knowledge, label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), readme);
  clearKbCache();
}

function writeManifest(json: unknown) {
  writeFileSync(join(SLAUDE_HOME, "slaude.json"), JSON.stringify(json, null, 2));
}

function readParsedManifest() {
  return JSON.parse(readFileSync(join(SLAUDE_HOME, "slaude.json"), "utf8"));
}

function readParsedLock() {
  return JSON.parse(readFileSync(join(SLAUDE_HOME, "slaude.lock"), "utf8"));
}

function hasGit(): boolean {
  try { execSync("git --version", { stdio: "pipe" }); return true; } catch { return false; }
}

function fakeBareRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "slaude-test-bare-"));
  execSync(`git init --bare -b main "${dir}"`, { stdio: "pipe" });
  return dir;
}

async function fakeBareRepoWithCommit(_label: string, filepath: string, content: string): Promise<string> {
  const bareDir = mkdtempSync(join(tmpdir(), "slaude-test-bare-"));
  execSync(`git init --bare -b main "${bareDir}"`, { stdio: "pipe" });
  const cloneDir = mkdtempSync(join(tmpdir(), "slaude-test-clone-"));
  try {
    execSync(`git clone "${bareDir}" "${cloneDir}"`, { stdio: "pipe" });
    // Empty bare repo inherits remote HEAD (CI may default to "master").
    // Force the local branch to "main" so pushes and subsequent clones work.
    execSync("git checkout --orphan main 2>/dev/null; git branch -M main 2>/dev/null || true", { cwd: cloneDir, stdio: "pipe" });
    mkdirSync(join(cloneDir, dirname(filepath)), { recursive: true });
    writeFileSync(join(cloneDir, filepath), content);
    execSync("git add -A", { cwd: cloneDir, stdio: "pipe" });
    execSync("git -c user.name=test -c user.email=test@test commit -m init", { cwd: cloneDir, stdio: "pipe" });
    execSync("git push origin HEAD", { cwd: cloneDir, stdio: "pipe" });
  } finally {
    rmSync(cloneDir, { recursive: true, force: true });
  }
  return bareDir;
}

async function commitToRemote(repoPath: string, filepath: string, content: string): Promise<string> {
  const cloneDir = mkdtempSync(join(tmpdir(), "slaude-test-clone-"));
  try {
    execSync(`git clone "${repoPath}" "${cloneDir}"`, { stdio: "pipe" });
    writeFileSync(join(cloneDir, filepath), content);
    execSync("git add -A", { cwd: cloneDir, stdio: "pipe" });
    execSync("git -c user.name=test -c user.email=test@test commit -m update", { cwd: cloneDir, stdio: "pipe" });
    execSync("git push origin HEAD", { cwd: cloneDir, stdio: "pipe" });
    return execSync("git rev-parse HEAD", { cwd: cloneDir, encoding: "utf8" }).trim();
  } finally {
    rmSync(cloneDir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  ensureHome();
  if (existsSync(paths.skills)) rmSync(paths.skills, { recursive: true, force: true });
  mkdirSync(paths.skills, { recursive: true });
  if (existsSync(paths.knowledge)) rmSync(paths.knowledge, { recursive: true, force: true });
  mkdirSync(paths.knowledge, { recursive: true });
  const mf = join(SLAUDE_HOME, "slaude.json");
  const lf = join(SLAUDE_HOME, "slaude.lock");
  if (existsSync(mf)) rmSync(mf);
  if (existsSync(lf)) rmSync(lf);
  // Clean up tmp files
  if (existsSync(mf + ".tmp")) rmSync(mf + ".tmp");
  if (existsSync(lf + ".tmp")) rmSync(lf + ".tmp");
  clearKbCache();
  delete process.env.SLAUDE_SKILLS_REPO;
});

describe("syncManifest", () => {
  test("no-op when nothing to sync", async () => {
    writeManifest({ plugins: [], skills: [], knowledge: [] });
    const r = await syncManifest();
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0]!.text);
    expect(parsed.synced_skills).toEqual([]);
    expect(parsed.synced_kbs).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });

  test("syncs local skill when SLAUDE_SKILLS_REPO is unset", async () => {
    writeManifest({ plugins: [], skills: [], knowledge: [] });
    skillOps.write("my-skill", "My Skill", "desc", "body");
    const r = await syncManifest();
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0]!.text);
    expect(parsed.synced_skills).toEqual(["my-skill"]);
    expect(parsed.synced_kbs).toEqual([]);
    expect(parsed.skills_in_git).toBe(false);
    expect(parsed.warnings.length).toBeGreaterThan(0);
    expect(parsed.warnings[0]).toContain("skills push target not set");

    const mf = readParsedManifest();
    expect(mf.skills.length).toBe(1);
    expect(mf.skills[0].slug).toBe("my-skill");
    expect(mf.skills[0].git).toBeUndefined();
  });

  test("syncs local KBs", async () => {
    writeManifest({ plugins: [], skills: [], knowledge: [] });
    seedKb("runbooks", "# Runbooks");
    const r = await syncManifest();
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0]!.text);
    expect(parsed.synced_kbs).toEqual(["runbooks"]);
    expect(parsed.synced_skills).toEqual([]);

    const mf = readParsedManifest();
    expect(mf.knowledge.length).toBe(1);
    expect(mf.knowledge[0].label).toBe("runbooks");
    expect(mf.knowledge[0].git).toBeUndefined();
  });

  test("idempotent: calling sync twice produces no duplicates", async () => {
    writeManifest({ plugins: [], skills: [], knowledge: [] });
    skillOps.write("idem", "Idem", "d", "b");
    const r1 = await syncManifest();
    const p1 = JSON.parse(r1.content[0]!.text);
    expect(p1.synced_skills).toEqual(["idem"]);

    const r2 = await syncManifest();
    const p2 = JSON.parse(r2.content[0]!.text);
    expect(p2.synced_skills).toEqual([]);
    expect(p2.synced_kbs).toEqual([]);

    const mf = readParsedManifest();
    expect(mf.skills.length).toBe(1);
  });

  test("skill already in manifest is not re-synced", async () => {
    writeManifest({ plugins: [], skills: [{ slug: "pre-existing" }], knowledge: [] });
    skillOps.write("pre-existing", "Pre", "d", "b");
    const r = await syncManifest();
    const parsed = JSON.parse(r.content[0]!.text);
    expect(parsed.synced_skills).toEqual([]);
  });

  test("manifest read error returns error", async () => {
    writeFileSync(join(SLAUDE_HOME, "slaude.json"), "{not-json");
    const r = await syncManifest();
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("invalid slaude.json");
  });

  test("lockfile read error is silently reset", async () => {
    writeManifest({ plugins: [], skills: [], knowledge: [] });
    writeFileSync(join(SLAUDE_HOME, "slaude.lock"), "garbage");
    skillOps.write("resilient", "R", "d", "b");
    const r = await syncManifest();
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0]!.text);
    expect(parsed.synced_skills).toEqual(["resilient"]);
  });

  test("lockfile is written with valid structure", async () => {
    writeManifest({ plugins: [], skills: [], knowledge: [] });
    skillOps.write("atomic", "A", "d", "b");
    const r = await syncManifest();
    expect(r.isError).toBeUndefined();

    const lock = readParsedLock();
    const validated = lockfileSchema.parse(lock);
    expect(validated.version).toBe(1);
    expect(validated.generated_at).toBeTruthy();
  });

  test("mixed skills and KBs in one sync", async () => {
    writeManifest({ plugins: [], skills: [], knowledge: [] });
    skillOps.write("s1", "S1", "d", "b");
    skillOps.write("s2", "S2", "d", "b");
    seedKb("kb1", "# KB1");
    const r = await syncManifest();
    const parsed = JSON.parse(r.content[0]!.text);
    expect(parsed.synced_skills.length).toBe(2);
    expect(parsed.synced_kbs.length).toBe(1);

    const mf = readParsedManifest();
    expect(mf.skills.length).toBe(2);
    expect(mf.knowledge.length).toBe(1);
  });

  test("existing manifest entries preserved", async () => {
    writeManifest({
      plugins: [{ marketplace: "github:foo/bar", plugin: "x", ref: "v1" }],
      skills: [{ git: "github:foo/old-skill", ref: "main" }],
      knowledge: [{ label: "old-kb", git: "github:foo/old-kb", ref: "main" }],
    });
    skillOps.write("new-skill", "New", "d", "b");
    const r = await syncManifest();
    const parsed = JSON.parse(r.content[0]!.text);
    expect(parsed.synced_skills).toEqual(["new-skill"]);

    const mf = readParsedManifest();
    expect(mf.plugins.length).toBe(1);
    expect(mf.skills.length).toBe(2);
    expect(mf.knowledge.length).toBe(1);
    expect(mf.plugins[0].plugin).toBe("x");
    expect(mf.skills.find((s: any) => (s.git ?? "") === "github:foo/old-skill")).toBeTruthy();
    expect(mf.knowledge[0].label).toBe("old-kb");
  });

  test("sync without manifest file creates one", async () => {
    skillOps.write("first", "First", "d", "b");
    const r = await syncManifest();
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0]!.text);
    expect(parsed.synced_skills).toEqual(["first"]);

    const mf = readParsedManifest();
    expect(mf.skills.length).toBe(1);
    manifestSchema.parse(mf);
  });

  test("sync preserves non-skill, non-KB manifest fields", async () => {
    writeManifest({
      plugins: [{ marketplace: "github:foo/bar", plugin: "x", ref: "v1" }],
      skills: [],
      knowledge: [],
    });
    skillOps.write("test", "Test", "d", "b");
    const r = await syncManifest();
    expect(r.isError).toBeUndefined();
    const mf = readParsedManifest();
    expect(mf.plugins.length).toBe(1);
    expect(mf.plugins[0].plugin).toBe("x");
  });

  test("sync_manifest pulls read-only KBs to declared ref", async () => {
    if (!hasGit()) return;
    const remote = await fakeBareRepoWithCommit("seed", "README.md", "# seed\n");
    const manifest = {
      plugins: [], skills: [],
      knowledge: [{ label: "ext-wiki", git: remote, ref: "main" }],
    };
    writeFileSync(join(SLAUDE_HOME, "slaude.json"), JSON.stringify(manifest));
    const kbDir = join(paths.knowledge, "ext-wiki");
    mkdirSync(kbDir, { recursive: true });
    writeFileSync(join(kbDir, "README.md"), "# STALE\n");

    const newSha = await commitToRemote(remote, "README.md", "# fresh\n");

    const r = await syncManifest();
    const out = JSON.parse(r.content[0]!.text);
    expect(out.pulled_kbs).toEqual(["ext-wiki"]);
    expect(readFileSync(join(kbDir, "README.md"), "utf8")).toBe("# fresh\n");

    const lock = JSON.parse(readFileSync(join(SLAUDE_HOME, "slaude.lock"), "utf8"));
    expect(lock.knowledge["ext-wiki"].sha).toBe(newSha);
  });

  test("sync_manifest pulls only `path:` subdir when set, rooted to kb dir", async () => {
    if (!hasGit()) return;
    // Seed a remote that has a `wiki/` subdir + non-wiki garbage at the root.
    const bareDir = mkdtempSync(join(tmpdir(), "slaude-test-bare-"));
    execSync(`git init --bare -b main "${bareDir}"`, { stdio: "pipe" });
    const cloneDir = mkdtempSync(join(tmpdir(), "slaude-test-clone-"));
    try {
      execSync(`git clone "${bareDir}" "${cloneDir}"`, { stdio: "pipe" });
      execSync("git checkout --orphan main 2>/dev/null; git branch -M main 2>/dev/null || true", { cwd: cloneDir, stdio: "pipe" });
      mkdirSync(join(cloneDir, "wiki"), { recursive: true });
      writeFileSync(join(cloneDir, "wiki", "README.md"), "# wiki home\n");
      writeFileSync(join(cloneDir, "wiki", "page-1.md"), "# page 1\n");
      writeFileSync(join(cloneDir, "src.go"), "package main\n"); // outside path; must NOT land
      writeFileSync(join(cloneDir, "README.md"), "# repo root\n");
      execSync("git add -A", { cwd: cloneDir, stdio: "pipe" });
      execSync("git -c user.name=test -c user.email=test@test commit -m init", { cwd: cloneDir, stdio: "pipe" });
      execSync("git push origin HEAD", { cwd: cloneDir, stdio: "pipe" });
    } finally {
      rmSync(cloneDir, { recursive: true, force: true });
    }
    const manifest = {
      plugins: [], skills: [],
      knowledge: [{ label: "loan-wiki", git: bareDir, ref: "main", path: "wiki" }],
    };
    writeFileSync(join(SLAUDE_HOME, "slaude.json"), JSON.stringify(manifest));

    const r = await syncManifest();
    expect(r.isError).toBeUndefined();
    const out = JSON.parse(r.content[0]!.text);
    expect(out.pulled_kbs).toEqual(["loan-wiki"]);

    // wiki/ contents land directly at kbDir root.
    const kbDir = join(paths.knowledge, "loan-wiki");
    expect(existsSync(join(kbDir, "README.md"))).toBe(true);
    expect(readFileSync(join(kbDir, "README.md"), "utf8")).toBe("# wiki home\n");
    expect(existsSync(join(kbDir, "page-1.md"))).toBe(true);
    // Out-of-path files must NOT appear.
    expect(existsSync(join(kbDir, "src.go"))).toBe(false);
    // Repo's root README must NOT clobber the wiki README.
    expect(readFileSync(join(kbDir, "README.md"), "utf8")).not.toContain("repo root");

    const lock = JSON.parse(readFileSync(join(SLAUDE_HOME, "slaude.lock"), "utf8"));
    expect(lock.knowledge["loan-wiki"].path).toBe("wiki");

    rmSync(bareDir, { recursive: true, force: true });
  });

  test("sync_manifest surfaces KB pull error as warning", async () => {
    writeManifest({
      plugins: [], skills: [],
      knowledge: [{ label: "broken-kb", git: "/nonexistent/kb/repo", ref: "main" }],
    });
    const kbDir = join(paths.knowledge, "broken-kb");
    mkdirSync(kbDir, { recursive: true });
    writeFileSync(join(kbDir, "README.md"), "# old\n");

    const r = await syncManifest();
    expect(r.isError).toBeUndefined();
    const out = JSON.parse(r.content[0]!.text);
    expect(out.warnings.length).toBeGreaterThan(0);
    expect(out.warnings[0]).toContain("pull broken-kb");
    expect(out.warnings[0]).toContain("nonexistent");

    // Lock should NOT contain the failed KB entry
    const lock = JSON.parse(readFileSync(join(SLAUDE_HOME, "slaude.lock"), "utf8"));
    expect(lock.knowledge["broken-kb"]).toBeUndefined();
  });

  test("sync_manifest pushes writable KB raw/ but not wiki/", async () => {
    if (!hasGit()) return;
    const remote = fakeBareRepo();
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
});

describe("git push", () => {
  test("pushSkillsToRepo handles empty repo", () => {
    if (!hasGit()) return;
    const bareDir = mkdtempSync(join(tmpdir(), "slaude-test-bare-"));
    try {
      execSync(`git init --bare -b main "${bareDir}"`, { stdio: "pipe" });
      skillOps.write("test-skill", "Test", "d", "body");
      const skillDir = join(paths.skills, "test-skill");
      const result = pushSkillsToRepo(bareDir, [{ slug: "test-skill", dir: skillDir }]);
      expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
    }
  });

  test("sync skills with SLAUDE_SKILLS_REPO set pushes to git", async () => {
    if (!hasGit()) return;
    const bareDir = mkdtempSync(join(tmpdir(), "slaude-test-bare-"));
    try {
      execSync(`git init --bare -b main "${bareDir}"`, { stdio: "pipe" });
      process.env.SLAUDE_SKILLS_REPO = bareDir;
      writeManifest({ plugins: [], skills: [], knowledge: [] });
      skillOps.write("pushed", "Pushed", "desc", "body");
      const r = await syncManifest();
      expect(r.isError).toBeUndefined();
      const parsed = JSON.parse(r.content[0]!.text);
      expect(parsed.skills_in_git).toBe(true);
      expect(parsed.synced_skills).toEqual(["pushed"]);
      expect(parsed.warnings).toEqual([]);

      const mf = readParsedManifest();
      expect(mf.skills[0].git).toBe(bareDir);
      expect(mf.skills[0].ref).toBe("main");
      expect(mf.skills[0].path).toBe("pushed");

      const lock = readParsedLock();
      expect(lock.skills["pushed"]).toBeDefined();
      expect(lock.skills["pushed"].sha).toMatch(/^[0-9a-f]{40}$/);
      expect(lock.skills["pushed"].path).toBe("pushed");
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
    }
  });

  test("git push failure falls back to local entries", async () => {
    // Use a non-existent git URL to force failure
    process.env.SLAUDE_SKILLS_REPO = "/nonexistent/path";
    writeManifest({ plugins: [], skills: [], knowledge: [] });
    skillOps.write("fallback-skill", "FB", "d", "b");
    const r = await syncManifest();
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0]!.text);
    expect(parsed.synced_skills).toEqual(["fallback-skill"]);
    expect(parsed.skills_in_git).toBe(false);
    expect(parsed.warnings.length).toBeGreaterThan(0);
    expect(parsed.warnings[0]).toContain("git push failed");

    const mf = readParsedManifest();
    expect(mf.skills[0].git).toBeUndefined();
    expect(mf.skills[0].slug).toBe("fallback-skill");
  });

  test("pushToRepo pushes KBs to knowledge/ subdirectory", () => {
    if (!hasGit()) return;
    const bareDir = mkdtempSync(join(tmpdir(), "slaude-test-bare-"));
    try {
      execSync(`git init --bare -b main "${bareDir}"`, { stdio: "pipe" });
      seedKb("runbooks", "# Runbooks\n\nOps procedures.");
      const kbDir = join(paths.knowledge, "runbooks");
      const result = pushToRepo(bareDir, [], [{ label: "runbooks", dir: kbDir }]);
      expect(result.sha).toMatch(/^[0-9a-f]{40}$/);

      // Clone back and verify structure
      const checkDir = mkdtempSync(join(tmpdir(), "slaude-check-"));
      try {
        execSync(`git clone "${bareDir}" "${checkDir}"`, { stdio: "pipe" });
        const kbReadme = join(checkDir, "knowledge", "runbooks", "README.md");
        expect(existsSync(kbReadme)).toBe(true);
        expect(readFileSync(kbReadme, "utf8")).toContain("Runbooks");
      } finally {
        rmSync(checkDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
    }
  });

  test("sync KBs with SLAUDE_SKILLS_REPO set pushes to git", async () => {
    if (!hasGit()) return;
    const bareDir = mkdtempSync(join(tmpdir(), "slaude-test-bare-"));
    try {
      execSync(`git init --bare -b main "${bareDir}"`, { stdio: "pipe" });
      process.env.SLAUDE_SKILLS_REPO = bareDir;
      writeManifest({ plugins: [], skills: [], knowledge: [] });
      seedKb("runbooks", "# Runbooks");
      const r = await syncManifest();
      expect(r.isError).toBeUndefined();
      const parsed = JSON.parse(r.content[0]!.text);
      expect(parsed.skills_in_git).toBe(true);
      expect(parsed.synced_kbs).toEqual(["runbooks"]);
      expect(parsed.warnings).toEqual([]);

      const mf = readParsedManifest();
      expect(mf.knowledge[0].label).toBe("runbooks");
      expect(mf.knowledge[0].git).toBe(bareDir);
      expect(mf.knowledge[0].ref).toBe("main");
      expect(mf.knowledge[0].path).toBe("knowledge/runbooks");

      const lock = readParsedLock();
      expect(lock.knowledge["runbooks"]).toBeDefined();
      expect(lock.knowledge["runbooks"].sha).toMatch(/^[0-9a-f]{40}$/);
      expect(lock.knowledge["runbooks"].path).toBe("knowledge/runbooks");
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
    }
  });

  test("sync skills and KBs together in one git push", async () => {
    if (!hasGit()) return;
    const bareDir = mkdtempSync(join(tmpdir(), "slaude-test-bare-"));
    try {
      execSync(`git init --bare -b main "${bareDir}"`, { stdio: "pipe" });
      process.env.SLAUDE_SKILLS_REPO = bareDir;
      writeManifest({ plugins: [], skills: [], knowledge: [] });
      skillOps.write("s1", "S1", "d", "b");
      seedKb("kb1", "# KB1");
      const r = await syncManifest();
      expect(r.isError).toBeUndefined();
      const parsed = JSON.parse(r.content[0]!.text);
      expect(parsed.synced_skills).toEqual(["s1"]);
      expect(parsed.synced_kbs).toEqual(["kb1"]);
      expect(parsed.skills_in_git).toBe(true);

      const mf = readParsedManifest();
      expect(mf.skills.length).toBe(1);
      expect(mf.skills[0].git).toBe(bareDir);
      expect(mf.knowledge.length).toBe(1);
      expect(mf.knowledge[0].git).toBe(bareDir);

      const lock = readParsedLock();
      expect(lock.skills["s1"].sha).toBe(lock.knowledge["kb1"].sha);
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
    }
  });

  test("git push failure falls back for both skills and KBs", async () => {
    process.env.SLAUDE_SKILLS_REPO = "/nonexistent/path";
    writeManifest({ plugins: [], skills: [], knowledge: [] });
    skillOps.write("fs", "FS", "d", "b");
    seedKb("fkb", "# FKB");
    const r = await syncManifest();
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content[0]!.text);
    expect(parsed.synced_skills).toEqual(["fs"]);
    expect(parsed.synced_kbs).toEqual(["fkb"]);
    expect(parsed.skills_in_git).toBe(false);
    expect(parsed.warnings[0]).toContain("git push failed");

    const mf = readParsedManifest();
    expect(mf.skills[0].git).toBeUndefined();
    expect(mf.skills[0].slug).toBe("fs");
    expect(mf.knowledge[0].git).toBeUndefined();
    expect(mf.knowledge[0].label).toBe("fkb");
  });

  test("sync_manifest pushes to manifest.slaude_skills.git when set, ignoring env", async () => {
    if (!hasGit()) return;
    process.env.SLAUDE_SKILLS_REPO = "https://wrong.example.com/repo.git";
    const repoRemote = fakeBareRepo();
    try {
      writeManifest({ plugins: [], skills: [], knowledge: [], slaude_skills: { git: repoRemote, ref: "main" } });
      mkdirSync(join(paths.skills, "demo"), { recursive: true });
      writeFileSync(join(paths.skills, "demo", "SKILL.md"), "---\nname: demo\ndescription: x\n---\nbody\n");

      const r = await syncManifest();
      const out = JSON.parse(r.content[0]!.text);
      expect(r.isError).toBeUndefined();
      expect(out.synced_skills).toEqual(["demo"]);
      expect(out.skills_in_git).toBe(true);

      const lock = JSON.parse(readFileSync(join(SLAUDE_HOME, "slaude.lock"), "utf8"));
      expect(lock.skills.demo.git).toBe(repoRemote);
    } finally {
      rmSync(repoRemote, { recursive: true, force: true });
    }
  });
});
