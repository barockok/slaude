import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalObjectStore, getText, putText } from "../../src/storage";
import {
  GLOBAL_SCOPE,
  notifySkillRemote,
  pullAll,
  pullSkill,
  pushSkill,
  scopeOf,
  seedAgentSkills,
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

  test("the skills sync state follows SLAUDE_SYNC_STATE_DIR", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const dir = tmp("state-dir");
    process.env.SLAUDE_SYNC_STATE_DIR = dir;
    try {
      const s = slug();
      writeLocal(GLOBAL_SCOPE, s, "state dir");
      await pushSkill(store, GLOBAL_SCOPE, s); // no stateFile: the environment decides
      expect(existsSync(join(dir, "skills-sync.json"))).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, "skills-sync.json"), "utf8")).versions[`${GLOBAL_SCOPE}/${s}`]).toBeTruthy();
    } finally {
      delete process.env.SLAUDE_SYNC_STATE_DIR;
    }
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

  test("seedAgentSkills publishes agent-written skills the store lacks, and leaves the rest alone", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const mine = slug("seed-agent");
    const placed = slug("seed-operator");
    const known = slug("seed-known");
    const stamped = (name: string) => `---\nname: ${name}\ndescription: test skill\nauthored_by: "agent"\nauthored_at: "2026-01-01T00:00:00Z"\n---\nbody\n`;
    for (const [s, text] of [
      [mine, stamped(mine)],
      [known, stamped(known)],
      [placed, skillMd(placed, "operator placed, no stamp")],
    ] as const) {
      mkdirSync(skillDirFor(GLOBAL_SCOPE, s), { recursive: true });
      writeFileSync(join(skillDirFor(GLOBAL_SCOPE, s), "SKILL.md"), text);
    }
    // The store already holds a head for one of them: it must not be republished or changed.
    await putText(store, `shared/skills-head/global/${known}.json`, JSON.stringify({ version: "000000000000001-aaaaaa", deleted: false, files: ["SKILL.md"], at: 1 }));

    const m = machine();
    const r = await seedAgentSkills(store, { ...m, personas: [] });
    expect(r.seeded).toContain(`global/${mine}`);
    expect(r.seeded).not.toContain(`global/${known}`);
    expect(r.seeded).not.toContain(`global/${placed}`);
    expect(await getText(store, `shared/skills-head/global/${mine}.json`)).not.toBeNull();
    expect(await getText(store, `shared/skills-head/global/${placed}.json`)).toBeNull();
    expect(JSON.parse((await getText(store, `shared/skills-head/global/${known}.json`))!).version).toBe("000000000000001-aaaaaa");

    // A second run finds nothing to do.
    const again = await seedAgentSkills(store, { ...m, personas: [] });
    expect(again.seeded).not.toContain(`global/${mine}`);

  });

  test("seedAgentSkills seeds a persona's own overlay under its scope only", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const s = slug("seed-persona");
    mkdirSync(skillDirFor("researcher", s), { recursive: true });
    writeFileSync(join(skillDirFor("researcher", s), "SKILL.md"), `---\nname: ${s}\ndescription: d\nauthored_by: "agent"\nauthored_at: "2026-01-01T00:00:00Z"\n---\nb\n`);
    const r = await seedAgentSkills(store, { ...machine(), personas: ["researcher"] });
    expect(r.seeded).toContain(`researcher/${s}`);
    expect(r.seeded).not.toContain(`global/${s}`);
  });

  const denied = (): never => {
    throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
  };

  test("a pull into a directory this process may not rewrite is a no-op when the content already matches", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const s = slug("ro");
    writeLocal(GLOBAL_SCOPE, s, "same everywhere");
    await pushSkill(store, GLOBAL_SCOPE, s, machine());
    // A machine with no state for it (the worker's first start) beside a gateway-owned copy must not fail or rewrite it.
    const m = { ...machine(), moveAside: denied };
    expect(await pullSkill(store, GLOBAL_SCOPE, s, m)).toBe("current");
    expect(readFileSync(join(skillDirFor(GLOBAL_SCOPE, s), "SKILL.md"), "utf8")).toContain("same everywhere");
    // The state now records it, so the next pull is current without touching anything.
    expect(await pullSkill(store, GLOBAL_SCOPE, s, m)).toBe("current");
  });

  test("a pull into a directory that may not be rewritten and holds different content still fails", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const s = slug("ro-diff");
    writeLocal(GLOBAL_SCOPE, s, "version one");
    await pushSkill(store, GLOBAL_SCOPE, s, machine());
    writeLocal(GLOBAL_SCOPE, s, "locally different");
    await expect(pullSkill(store, GLOBAL_SCOPE, s, { ...machine(), moveAside: denied })).rejects.toThrow("EPERM");
    expect(readFileSync(join(skillDirFor(GLOBAL_SCOPE, s), "SKILL.md"), "utf8")).toContain("locally different");
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
