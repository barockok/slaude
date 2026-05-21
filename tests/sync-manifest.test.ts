import { describe, expect, test, beforeEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
    expect(parsed.warnings[0]).toContain("SLAUDE_SKILLS_REPO not set");

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
});

describe("git push", () => {
  test("pushSkillsToRepo handles empty repo", () => {
    if (!hasGit()) return;
    const bareDir = mkdtempSync(join(tmpdir(), "slaude-test-bare-"));
    try {
      execSync(`git init --bare "${bareDir}"`, { stdio: "pipe" });
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
      execSync(`git init --bare "${bareDir}"`, { stdio: "pipe" });
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
      execSync(`git init --bare "${bareDir}"`, { stdio: "pipe" });
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
      execSync(`git init --bare "${bareDir}"`, { stdio: "pipe" });
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
      execSync(`git init --bare "${bareDir}"`, { stdio: "pipe" });
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
});
