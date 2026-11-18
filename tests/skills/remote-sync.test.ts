import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalObjectStore, putText } from "../../src/storage";
import {
  GLOBAL_SCOPE,
  notifySkillRemote,
  pullAll,
  pullSkill,
  pushSkill,
  scopeOf,
  setSkillRemote,
  skillDirFor,
  startSkillMirror,
  type SkillBus,
} from "../../src/skills/remote-sync";
import { skillOps } from "../../src/skills/mcp-tools";
import { metrics } from "../../src/metrics";

const dirs: string[] = [];
const tmp = (n: string): string => {
  const d = mkdtempSync(join(tmpdir(), `slaude-skills-${n}-`));
  dirs.push(d);
  return d;
};
const slugs: string[] = [];
let n = 0;
const slug = (p = "rt"): string => {
  const s = `${p}-${Date.now().toString(36)}-${++n}`;
  slugs.push(s);
  return s;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  for (const s of slugs) {
    rmSync(skillDirFor(GLOBAL_SCOPE, s), { recursive: true, force: true });
    rmSync(skillDirFor("researcher", s), { recursive: true, force: true });
  }
});

const skillMd = (name: string, body: string) => `---\nname: ${name}\ndescription: test skill\n---\n${body}\n`;

function writeLocal(scope: string, s: string, body: string, extra?: Record<string, string>): void {
  const dir = skillDirFor(scope, s);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skillMd(s, body));
  for (const [rel, text] of Object.entries(extra ?? {})) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
}

const machine = () => ({ stateFile: join(tmp("state"), "skills-sync.json") });

describe("runtime skills over the object store", () => {
  test("scopeOf maps the default persona and no persona to the shared base", () => {
    expect(scopeOf(undefined)).toBe(GLOBAL_SCOPE);
    expect(scopeOf("default")).toBe(GLOBAL_SCOPE);
    expect(scopeOf("researcher")).toBe("researcher");
  });

  test("a skill pushed from one machine arrives intact on another", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const s = slug();
    const a = machine();
    writeLocal(GLOBAL_SCOPE, s, "learned on A", { "refs/notes.md": "extra file" });
    const pushed = await pushSkill(store, GLOBAL_SCOPE, s, a);
    expect(pushed.deleted).toBe(false);

    rmSync(skillDirFor(GLOBAL_SCOPE, s), { recursive: true, force: true }); // a different machine
    const b = machine();
    expect(await pullSkill(store, GLOBAL_SCOPE, s, b)).toBe("updated");
    expect(readFileSync(join(skillDirFor(GLOBAL_SCOPE, s), "SKILL.md"), "utf8")).toContain("learned on A");
    expect(readFileSync(join(skillDirFor(GLOBAL_SCOPE, s), "refs", "notes.md"), "utf8")).toBe("extra file");
    expect(await pullSkill(store, GLOBAL_SCOPE, s, b)).toBe("current");
  });

  test("an edit replaces the old files, dropping ones the new version no longer has", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const s = slug();
    const a = machine();
    writeLocal(GLOBAL_SCOPE, s, "v1", { "old.md": "gone soon" });
    await pushSkill(store, GLOBAL_SCOPE, s, a);
    const b = machine();
    await pullSkill(store, GLOBAL_SCOPE, s, b);
    rmSync(join(skillDirFor(GLOBAL_SCOPE, s), "old.md"));
    writeLocal(GLOBAL_SCOPE, s, "v2");
    await pushSkill(store, GLOBAL_SCOPE, s, a);
    expect(await pullSkill(store, GLOBAL_SCOPE, s, b)).toBe("updated");
    expect(readFileSync(join(skillDirFor(GLOBAL_SCOPE, s), "SKILL.md"), "utf8")).toContain("v2");
    expect(existsSync(join(skillDirFor(GLOBAL_SCOPE, s), "old.md"))).toBe(false);
  });

  test("a delete is a tombstone that removes the skill on another machine", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const s = slug();
    const a = machine();
    writeLocal(GLOBAL_SCOPE, s, "short lived");
    await pushSkill(store, GLOBAL_SCOPE, s, a);
    const b = machine();
    await pullSkill(store, GLOBAL_SCOPE, s, b);
    rmSync(skillDirFor(GLOBAL_SCOPE, s), { recursive: true, force: true });
    expect((await pushSkill(store, GLOBAL_SCOPE, s, a)).deleted).toBe(true);
    writeLocal(GLOBAL_SCOPE, s, "still here on B");
    expect(await pullSkill(store, GLOBAL_SCOPE, s, b)).toBe("deleted");
    expect(existsSync(skillDirFor(GLOBAL_SCOPE, s))).toBe(false);
  });

  test("deleting an overlay of a bundled skill brings the bundled one back", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const bundled = "how-slaude-works";
    const dir = skillDirFor(GLOBAL_SCOPE, bundled);
    const saved = existsSync(join(dir, "SKILL.md")) ? readFileSync(join(dir, "SKILL.md"), "utf8") : null;
    try {
      const a = machine();
      writeLocal(GLOBAL_SCOPE, bundled, "agent's own take on a bundled skill");
      await pushSkill(store, GLOBAL_SCOPE, bundled, a);
      rmSync(dir, { recursive: true, force: true });
      await pushSkill(store, GLOBAL_SCOPE, bundled, a); // tombstone
      const b = machine();
      writeLocal(GLOBAL_SCOPE, bundled, "overlay still on B");
      expect(await pullSkill(store, GLOBAL_SCOPE, bundled, b)).toBe("deleted");
      expect(readFileSync(join(dir, "SKILL.md"), "utf8")).not.toContain("overlay still on B");
      expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
    } finally {
      if (saved !== null) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "SKILL.md"), saved);
      } else rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a persona's own skill syncs under its scope", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const s = slug("persona");
    const a = machine();
    writeLocal("researcher", s, "persona skill");
    await pushSkill(store, "researcher", s, a);
    rmSync(skillDirFor("researcher", s), { recursive: true, force: true });
    expect(await pullSkill(store, "researcher", s, machine())).toBe("updated");
    expect(readFileSync(join(skillDirFor("researcher", s), "SKILL.md"), "utf8")).toContain("persona skill");
    expect(existsSync(skillDirFor(GLOBAL_SCOPE, s))).toBe(false);
  });

  test("pullAll catches a fresh machine up and then costs only a list", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const s1 = slug();
    const s2 = slug();
    const a = machine();
    writeLocal(GLOBAL_SCOPE, s1, "one");
    writeLocal(GLOBAL_SCOPE, s2, "two");
    await pushSkill(store, GLOBAL_SCOPE, s1, a);
    await pushSkill(store, GLOBAL_SCOPE, s2, a);
    rmSync(skillDirFor(GLOBAL_SCOPE, s1), { recursive: true, force: true });
    rmSync(skillDirFor(GLOBAL_SCOPE, s2), { recursive: true, force: true });
    const b = machine();
    const seen = new Map<string, string>();
    const first = await pullAll(store, { ...b, seen });
    expect(first.updated).toBeGreaterThanOrEqual(2);
    expect(existsSync(join(skillDirFor(GLOBAL_SCOPE, s1), "SKILL.md"))).toBe(true);
    const second = await pullAll(store, { ...b, seen });
    expect(second).toEqual({ updated: 0, deleted: 0 });
  });

  test("unsafe scope or slug is refused on push and pull", async () => {
    const store = new LocalObjectStore(tmp("store"));
    await expect(pushSkill(store, "../evil", "x", machine())).rejects.toThrow(/unsafe name/);
    await expect(pushSkill(store, GLOBAL_SCOPE, "Bad Slug", machine())).rejects.toThrow(/unsafe name/);
    expect(await pullSkill(store, "../evil", "x", machine())).toBe("refused");
  });

  test("a head that names a path outside the skill is refused and leaves nothing behind", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const s = slug();
    await putText(store, `shared/skills-head/${GLOBAL_SCOPE}/${s}.json`, JSON.stringify({ version: "v1", deleted: false, files: ["../../escape.txt"], at: 1 }));
    await expect(pullSkill(store, GLOBAL_SCOPE, s, machine())).rejects.toThrow(/unsafe path/);
    expect(existsSync(skillDirFor(GLOBAL_SCOPE, s))).toBe(false);
  });

  test("a head whose files are missing from the store fails without touching the local copy", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const s = slug();
    writeLocal(GLOBAL_SCOPE, s, "local copy");
    await putText(store, `shared/skills-head/${GLOBAL_SCOPE}/${s}.json`, JSON.stringify({ version: "v9", deleted: false, files: ["SKILL.md"], at: 1 }));
    await expect(pullSkill(store, GLOBAL_SCOPE, s, machine())).rejects.toThrow(/missing from the store/);
    expect(readFileSync(join(skillDirFor(GLOBAL_SCOPE, s), "SKILL.md"), "utf8")).toContain("local copy");
  });

  test("skillOps.write publishes through the installed hook, and a peer's message refreshes the local copy", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const handlers: Array<(p: string) => void> = [];
    const published: string[] = [];
    const bus: SkillBus = {
      publishSkillChanged: async (p) => {
        published.push(p);
        return 1;
      },
      onSkillChanged: async (cb) => {
        handlers.push(cb);
        return async () => {};
      },
    };
    const o = machine();
    const mirror = await startSkillMirror({ store, bus, opts: o });
    try {
      const s = slug("wired");
      skillOps.write(s, s, "wired up", "authored at runtime");
      await Bun.sleep(150); // the hook is fire and forget
      expect(published.length).toBe(1);
      const msg = JSON.parse(published[0]!) as { scope: string; slug: string; version: string };
      expect(msg).toMatchObject({ scope: GLOBAL_SCOPE, slug: s });
      expect(await store.head(`shared/skills-head/${GLOBAL_SCOPE}/${s}.json`)).not.toBeNull();

      // Another machine wrote a newer version: the channel message makes this one fetch it.
      const peer = machine();
      writeLocal(GLOBAL_SCOPE, s, "newer, from a peer");
      const pushed = await pushSkill(store, GLOBAL_SCOPE, s, peer);
      rmSync(skillDirFor(GLOBAL_SCOPE, s), { recursive: true, force: true });
      handlers[0]!(JSON.stringify({ scope: GLOBAL_SCOPE, slug: s, version: pushed.version, at: Date.now() - 250 }));
      await Bun.sleep(150);
      expect(readFileSync(join(skillDirFor(GLOBAL_SCOPE, s), "SKILL.md"), "utf8")).toContain("newer, from a peer");
      expect(metrics.render()).toContain("slaude_skills_invalidation_lag_seconds_count");
    } finally {
      await mirror.stop();
    }
  });

  test("a message that is not JSON or names nothing is ignored", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const handlers: Array<(p: string) => void> = [];
    const mirror = await startSkillMirror({
      store,
      bus: { publishSkillChanged: async () => 0, onSkillChanged: async (cb) => (handlers.push(cb), async () => {}) },
      opts: machine(),
    });
    try {
      handlers[0]!("not json");
      handlers[0]!("{}");
      await Bun.sleep(30);
    } finally {
      await mirror.stop();
    }
  });

  test("notifySkillRemote does nothing, and does not throw, with no hook installed or a failing one", async () => {
    setSkillRemote(null);
    notifySkillRemote(undefined, "anything");
    setSkillRemote(async () => {
      throw new Error("store down");
    });
    notifySkillRemote(undefined, "anything");
    await Bun.sleep(20);
    setSkillRemote(null);
  });
});
