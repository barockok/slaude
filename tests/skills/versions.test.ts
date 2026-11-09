/**
 * The skill version log: reconcile records a version only when a skill's
 * content changes, never breaks on an unreadable skill, and is safe with
 * several gateway replicas writing at once.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../src/config/home";
import { db } from "../../src/db/schema";
import * as SkillVersions from "../../src/db/skill-versions";
import { runningLoops, stopRunningLoops } from "../../src/gateway/core/running-loops";
import { skillOps } from "../../src/skills/mcp-tools";
import {
  fingerprintSkill,
  flushSkillVersionCaptures,
  noteSkillChanged,
  reconcileSkillVersions,
  recordFingerprint,
  startSkillVersionReconciler,
  versionScope,
  type SkillFingerprint,
} from "../../src/skills/versions";

const NOW = 1_800_000_000_000;
const made: string[] = [];

const place = (slug: string, md = `---\nname: ${slug}\ndescription: d\n---\nbody\n`, root = paths.skills): string => {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), md);
  made.push(dir);
  return dir;
};

const rows = (slug: string, scope = "global") => SkillVersions.list(scope, slug, 50);
const hashOf = (dir: string) => fingerprintSkill(dir).then((f) => f.hash);

let errSpy: ReturnType<typeof spyOn>;
beforeEach(async () => {
  mkdirSync(paths.skills, { recursive: true });
  await db.run("DELETE FROM skill_versions");
  errSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  await flushSkillVersionCaptures();
  errSpy.mockRestore();
  for (const d of made.splice(0)) {
    try { chmodSync(join(d, "secret.md"), 0o644); } catch { /* not every skill has one */ }
    rmSync(d, { recursive: true, force: true });
  }
  rmSync(join(paths.skills, ".retired"), { recursive: true, force: true });
});

describe("reconcile", () => {
  test("first capture records version 1 with the fields of the skill", async () => {
    const md = `---\nname: first-x\ndescription: d\nauthored_by: agent\n---\nbody\n`;
    const dir = place("first-x", md);
    writeFileSync(join(dir, "notes.txt"), "abc");
    const r = await reconcileSkillVersions(NOW);
    expect(r.recorded).toBeGreaterThanOrEqual(1);
    const [v, ...rest] = await rows("first-x");
    expect(rest).toEqual([]);
    expect(v).toMatchObject({ scope: "global", slug: "first-x", version: 1, fileCount: 2, totalBytes: Buffer.byteLength(md) + 3, capturedAt: NOW, origin: "agent", skillMdTruncated: false });
    expect(v!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await SkillVersions.get("global", "first-x", 1))!.skillMd).toBe(md);
  });

  test("an overlay skill is recorded under its persona, apart from the base skill of that slug", async () => {
    place("shared-x");
    place("shared-x", "---\nname: shared-x\n---\nscout's own\n", join(paths.personas, "scout-v", "skills"));
    made.push(join(paths.personas, "scout-v"));
    await reconcileSkillVersions(NOW);
    expect(await rows("shared-x")).toHaveLength(1);
    expect(await rows("shared-x", "scout-v")).toHaveLength(1);
  });

  test("no change writes nothing", async () => {
    place("same-x");
    await reconcileSkillVersions(NOW);
    const r = await reconcileSkillVersions(NOW + 1);
    expect(r.recorded).toBe(0);
    expect(await rows("same-x")).toHaveLength(1);
  });

  test("changed content adds a version, also for a file other than SKILL.md, and a deleted file keeps the history", async () => {
    const dir = place("change-x");
    writeFileSync(join(dir, "helper.sh"), "echo 1\n");
    await reconcileSkillVersions(NOW);
    writeFileSync(join(dir, "SKILL.md"), "---\nname: change-x\n---\nedited\n");
    await reconcileSkillVersions(NOW + 1);
    writeFileSync(join(dir, "helper.sh"), "echo 2\n");
    await reconcileSkillVersions(NOW + 2);
    unlinkSync(join(dir, "helper.sh"));
    await reconcileSkillVersions(NOW + 3);
    const all = await rows("change-x");
    expect(all.map((v) => v.version)).toEqual([4, 3, 2, 1]);
    expect(all[0]!.fileCount).toBe(1);
    expect((await SkillVersions.get("global", "change-x", 1))!.skillMd).toContain("body");
    expect((await SkillVersions.get("global", "change-x", 4))!.skillMd).toContain("edited");
  });

  test("the hash does not change for tool state in the tree", async () => {
    const dir = place("tools-x");
    await reconcileSkillVersions(NOW);
    mkdirSync(join(dir, "__pycache__"));
    writeFileSync(join(dir, "__pycache__", "a.pyc"), "bytes");
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "FETCH_HEAD"), "x");
    mkdirSync(join(dir, "scripts", "node_modules", "dep"), { recursive: true });
    writeFileSync(join(dir, "scripts", "node_modules", "dep", "index.js"), "x");
    mkdirSync(join(dir, ".venv", "bin"), { recursive: true });
    writeFileSync(join(dir, ".venv", "bin", "python"), "x");
    writeFileSync(join(dir, ".DS_Store"), "x");
    writeFileSync(join(dir, "scripts", ".DS_Store"), "x");
    const r = await reconcileSkillVersions(NOW + 1);
    expect(r.recorded).toBe(0);
  });

  test("the hash is deterministic and depends on the path and the bytes", async () => {
    const a = mkdtempSync(join(tmpdir(), "skill-a-"));
    const b = mkdtempSync(join(tmpdir(), "skill-b-"));
    made.push(a, b);
    for (const d of [a, b]) {
      writeFileSync(join(d, "SKILL.md"), "same\n");
      mkdirSync(join(d, "sub"));
      writeFileSync(join(d, "sub", "x.txt"), "1");
      writeFileSync(join(d, "z.txt"), "2");
    }
    expect(await hashOf(a)).toBe(await hashOf(b));
    writeFileSync(join(b, "sub", "y.txt"), "1");
    unlinkSync(join(b, "sub", "x.txt"));
    expect(await hashOf(a)).not.toBe(await hashOf(b));
  });

  test("SKILL.md past the cap is cut and flagged, the hash still covers all of it", async () => {
    const big = `${"a".repeat(256 * 1024)}tail`;
    const dir = place("big-x", big);
    const before = await fingerprintSkill(dir);
    expect(before.truncated).toBe(true);
    expect(Buffer.byteLength(before.skillMd)).toBe(256 * 1024);
    writeFileSync(join(dir, "SKILL.md"), `${"a".repeat(256 * 1024)}tale`);
    expect((await fingerprintSkill(dir)).hash).not.toBe(before.hash);
  });

  test("a NUL byte is stored as a replacement character", async () => {
    place("nul-x", "before\0after\n");
    await reconcileSkillVersions(NOW);
    expect((await SkillVersions.get("global", "nul-x", 1))!.skillMd).toBe("before�after\n");
  });

  test("a symlink is hashed by its target and never followed", async () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    made.push(outside);
    writeFileSync(join(outside, "secret.txt"), "top-secret-1");
    const dir = place("link-x");
    symlinkSync(join(outside, "secret.txt"), join(dir, "linked.txt"));
    const first = await fingerprintSkill(dir);
    writeFileSync(join(outside, "secret.txt"), "top-secret-2");
    expect((await fingerprintSkill(dir)).hash).toBe(first.hash);
    expect(first.totalBytes).toBe(Buffer.byteLength(`---\nname: link-x\ndescription: d\n---\nbody\n`));
  });

  test("a symlinked SKILL.md or skill directory is not recorded", async () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    made.push(outside);
    writeFileSync(join(outside, "SKILL.md"), "elsewhere\n");
    const dir = place("mdlink-x");
    unlinkSync(join(dir, "SKILL.md"));
    symlinkSync(join(outside, "SKILL.md"), join(dir, "SKILL.md"));
    const linkDir = join(paths.skills, "dirlink-x");
    symlinkSync(outside, linkDir);
    made.push(linkDir);
    await reconcileSkillVersions(NOW);
    expect(await rows("mdlink-x")).toEqual([]);
    expect(await rows("dirlink-x")).toEqual([]);
  });

  test("an unreadable file skips that skill for the pass, the others continue, and the log has no content", async () => {
    if (process.getuid?.() === 0) return; // root reads through chmod 000
    const dir = place("locked-x", "---\nname: locked-x\n---\nCONTENT-NOT-FOR-LOGS\n");
    writeFileSync(join(dir, "secret.md"), "CONTENT-NOT-FOR-LOGS");
    chmodSync(join(dir, "secret.md"), 0o000);
    place("fine-x");
    const r = await reconcileSkillVersions(NOW);
    expect(r.failed).toBeGreaterThanOrEqual(1);
    expect(await rows("locked-x")).toEqual([]);
    expect(await rows("fine-x")).toHaveLength(1);
    const logged = errSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(logged).toContain("global/locked-x");
    expect(logged).toContain("EACCES");
    expect(logged).not.toContain("CONTENT-NOT-FOR-LOGS");
  });

  test("a broken log never throws out of reconcile", async () => {
    place("nodb-x");
    await db.run("ALTER TABLE skill_versions RENAME TO skill_versions_held");
    try {
      const r = await reconcileSkillVersions(NOW);
      expect(r.failed).toBeGreaterThanOrEqual(1);
    } finally {
      await db.run("ALTER TABLE skill_versions_held RENAME TO skill_versions");
    }
    expect(await rows("nodb-x")).toEqual([]);
  });
});

describe("retire and restore", () => {
  const agentMd = (slug: string, extra = "") => `---\nname: ${slug}\ndescription: d\nauthored_by: agent\n---\nbody${extra}\n`;

  test("a retired skill keeps its history, and a restore with the same content adds nothing", async () => {
    place("gone-x", agentMd("gone-x"));
    await reconcileSkillVersions(NOW);
    const { id } = skillOps.retire("gone-x");
    await flushSkillVersionCaptures();
    await reconcileSkillVersions(NOW + 1);
    expect(await rows("gone-x")).toHaveLength(1);
    skillOps.restore(id);
    await flushSkillVersionCaptures();
    expect(await rows("gone-x")).toHaveLength(1);
  });

  test("the last edit before a retirement reaches the log", async () => {
    const dir = place("edit-x", agentMd("edit-x"));
    await reconcileSkillVersions(NOW);
    writeFileSync(join(dir, "SKILL.md"), agentMd("edit-x", " edited"));
    skillOps.retire("edit-x");
    await flushSkillVersionCaptures();
    const all = await rows("edit-x");
    expect(all.map((v) => v.version)).toEqual([2, 1]);
    expect((await SkillVersions.get("global", "edit-x", 2))!.skillMd).toContain("edited");
  });

  test("write_skill records the new content right after the write", async () => {
    skillOps.write("written-x", "written-x", "d", "first", undefined, new Date(NOW));
    made.push(join(paths.skills, "written-x"));
    await flushSkillVersionCaptures();
    skillOps.write("written-x", "written-x", "d", "second", undefined, new Date(NOW + 1000));
    await flushSkillVersionCaptures();
    const all = await rows("written-x");
    expect(all.map((v) => v.version)).toEqual([2, 1]);
    expect(all[0]!.origin).toBe("agent");
    expect((await SkillVersions.get("global", "written-x", 2))!.skillMd).toContain("second");
  });

  test("a process with no database does not capture", async () => {
    const dir = place("node-x");
    const saved = process.env.SLAUDE_ROLE;
    process.env.SLAUDE_ROLE = "node";
    try {
      noteSkillChanged(undefined, "node-x", dir);
      await flushSkillVersionCaptures();
    } finally {
      if (saved === undefined) delete process.env.SLAUDE_ROLE;
      else process.env.SLAUDE_ROLE = saved;
    }
    expect(await rows("node-x")).toEqual([]);
  });
});

describe("the reconciler's timer", () => {
  test("is a registered loop that its stop function ends, and stopping twice is harmless", () => {
    const before = runningLoops();
    const stop = startSkillVersionReconciler();
    expect(runningLoops()).toBe(before + 1);
    stop();
    expect(runningLoops()).toBe(before);
    stop();
    expect(runningLoops()).toBe(before);
  });

  test("an owner that never stops is ended by stopRunningLoops", () => {
    startSkillVersionReconciler();
    expect(runningLoops()).toBeGreaterThan(0);
    stopRunningLoops();
    expect(runningLoops()).toBe(0);
  });

  test("a process with no database starts no timer", () => {
    const saved = process.env.SLAUDE_ROLE;
    const before = runningLoops();
    process.env.SLAUDE_ROLE = "node";
    try {
      startSkillVersionReconciler()();
      expect(runningLoops()).toBe(before);
    } finally {
      if (saved === undefined) delete process.env.SLAUDE_ROLE;
      else process.env.SLAUDE_ROLE = saved;
    }
  });
});

describe("several replicas", () => {
  const fp = (hash: string): SkillFingerprint => ({ hash, fileCount: 1, totalBytes: 1, skillMd: "x", truncated: false });
  const rowFor = (slug: string, version: number, hash: string) => ({
    scope: "global",
    slug,
    version,
    contentHash: hash,
    skillMd: "theirs",
    skillMdTruncated: false,
    fileCount: 1,
    totalBytes: 1,
    capturedAt: NOW,
    origin: "installed" as const,
  });

  test("two replicas reconciling the same content leave one row", async () => {
    place("race-x");
    await Promise.all([reconcileSkillVersions(NOW), reconcileSkillVersions(NOW)]);
    expect(await rows("race-x")).toHaveLength(1);
  });

  test("losing the race to the same content writes nothing", async () => {
    const stale = {
      latest: async () => null,
      insert: SkillVersions.insert,
    };
    await SkillVersions.insert(rowFor("race-same", 1, "h1"));
    // The stale reader tries version 1, loses the conflict, then re-reads via the real repo.
    let first = true;
    const repo = { ...stale, latest: async (s: string, n: string) => (first ? ((first = false), null) : SkillVersions.latest(s, n)) };
    expect(await recordFingerprint("global", "race-same", fp("h1"), "installed", NOW, repo)).toBeNull();
    expect(await rows("race-same")).toHaveLength(1);
  });

  test("losing the race to different content takes the next version", async () => {
    await SkillVersions.insert(rowFor("race-diff", 1, "theirs"));
    let first = true;
    const repo = { insert: SkillVersions.insert, latest: async (s: string, n: string) => (first ? ((first = false), null) : SkillVersions.latest(s, n)) };
    expect(await recordFingerprint("global", "race-diff", fp("mine"), "agent", NOW, repo)).toBe(2);
    const all = await rows("race-diff");
    expect(all.map((v) => v.contentHash)).toEqual(["mine", "theirs"]);
  });

  test("repeated conflicts give up instead of spinning", async () => {
    const repo = { latest: async () => null, insert: async () => false };
    await expect(recordFingerprint("global", "race-busy", fp("x"), "agent", NOW, repo)).rejects.toThrow();
  });
});

test("versionScope: the shared base is global, a persona is its name, and no persona shares global", () => {
  expect(versionScope()).toBe("global");
  expect(versionScope("default")).toBe("global");
  expect(versionScope("scout")).toBe("scout");
  expect(versionScope("global")).toBe("persona:global");
});
