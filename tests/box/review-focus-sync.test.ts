/**
 * Review focus, items 6 and 8 (box plan, "Review Focus"), where the phase
 * suites stop short:
 *
 *   - item 6 is asserted there for the home unit; here for the workspace
 *     extras (`wx`) alone, with the home still owned by this node;
 *   - item 8: the transcript unit id of one working directory is the same for
 *     a boxed and an unboxed session, and it is the folder a box is given at
 *     an identical path.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localPacker } from "../../src/box/boxd/pack";
import { defaultBoxPolicy } from "../../src/box/policy";
import { buildBoxSpec } from "../../src/box/resolver";
import { FsSync, encodeProjectDir, type FsSyncDeps, type RedisLike } from "../../src/node/fs-sync";
import { makeKeys } from "../../src/queue/keys";
import { LocalObjectStore, hmUnitId, latestManifest, listAll, wsUnitId, wxUnitId, type ObjectStore } from "../../src/storage";
import { txUnitId } from "../../src/storage/units";

const dirs: string[] = [];
const tmp = (name: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `slaude-rf-sync-${name}-`)));
  dirs.push(d);
  return d;
};
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
});

function memRedis(): RedisLike {
  const m = new Map<string, string>();
  return {
    get: async (k) => m.get(k) ?? null,
    incr: async (k) => {
      const v = Number(m.get(k) ?? 0) + 1;
      m.set(k, String(v));
      return v;
    },
    set: async (k, v) => {
      m.set(k, v);
      return "OK";
    },
    del: async (...ks) => {
      for (const k of ks) m.delete(k);
      return ks.length;
    },
  };
}

const D1 = `sha256:${"1".repeat(64)}`;

/** One node's disk: a shared workspace and transcript tree, and this node's own state, homes and spool. */
interface Disk {
  cwd: string;
  claude: string;
  state: string;
  homes: string;
  spool: string;
}
function disk(root: string, tag: string): Disk {
  return { cwd: join(root, "workspaces", "w1"), claude: join(root, "claude"), state: join(root, `state-${tag}`), homes: join(root, `homes-${tag}`), spool: join(root, `spool-${tag}`) };
}

function node(o: { id: string; store: ObjectStore; redis: RedisLike; d: Disk; boxed: boolean; deps?: Partial<FsSyncDeps> }): FsSync {
  process.env.CLAUDE_CONFIG_DIR = o.d.claude;
  return new FsSync({
    store: o.store,
    redis: o.redis,
    keys: makeKeys("test"),
    nodeId: o.id,
    flush: () => "turn",
    workingDirOf: async () => o.d.cwd,
    nodeAlive: async () => false,
    stateDir: o.d.state,
    ...(o.boxed ? { packer: localPacker({ spoolDir: o.d.spool }), boxOf: (sid: string) => ({ digest: D1, homeDir: join(o.d.homes, sid) }) } : {}),
    ...o.deps,
  });
}

const unitsIn = async (store: ObjectStore): Promise<string[]> => [...new Set((await listAll(store, "sessions/")).map((x) => x.key.split("/")[1]!))].sort();
const txDirOf = (d: Disk): string => join(d.claude, "projects", encodeProjectDir(d.cwd));

describe("review focus 6: a fenced workspace-extras flush", () => {
  test("commits nothing, names the unit and its session to the caller, and the session's copies are discarded, not parked", async () => {
    const root = tmp("fence");
    const store = new LocalObjectStore(tmp("store"));
    const redis = memRedis();
    const da = disk(root, "a");
    const fenced: [string, string[]][] = [];
    const a = node({ id: "node-a", store, redis, d: da, boxed: true, deps: { onFenced: (unit, sessions) => fenced.push([unit, sessions]) } });
    const wx = wxUnitId(da.cwd, D1);

    expect(await a.beforeTurn("s1", "default")).toBe("ok");
    mkdirSync(join(da.cwd, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(da.cwd, "node_modules", "left-pad", "index.js"), "v1");
    writeFileSync(join(da.homes, "s1", "notes"), "home of s1");
    await a.afterTurn("s1", false);
    expect(await unitsIn(store)).toContain(wx);

    // Another node runs ANOTHER session of the same folder on the same image: it takes the folder's units
    // (workspace, transcript, extras) and leaves s1's home alone.
    const b = node({ id: "node-b", store, redis, d: disk(root, "b"), boxed: true });
    expect(await b.beforeTurn("s2", "default")).toBe("ok");
    writeFileSync(join(da.cwd, "node_modules", "left-pad", "index.js"), "v2 from the other node");
    await b.afterTurn("s2", false);
    const wxLatest = (await latestManifest(store, wx))!.id;
    const hmLatest = (await latestManifest(store, hmUnitId("s1")))!.id;

    // Node A, which does not know, finishes a turn of s1 with a write in the extras.
    writeFileSync(join(da.cwd, "node_modules", "left-pad", "index.js"), "zombie write");
    process.env.CLAUDE_CONFIG_DIR = da.claude;
    await a.afterTurn("s1", false);

    // Never committed: the stored extras are still the other node's.
    expect((await latestManifest(store, wx))!.id).toBe(wxLatest);
    // The caller is told which unit and which session, so it can stop that session's sandbox.
    expect(fenced.find(([unit]) => unit === wx)?.[1]).toEqual(["s1"]);
    expect(fenced.map(([unit]) => unit)).not.toContain(hmUnitId("s1"));
    // This copy can no longer pass for the stored state: no marker, no index, nothing pending.
    expect(existsSync(join(da.state, `${wx}.json`))).toBe(false);
    expect(existsSync(join(da.state, `${wx}.index.json`))).toBe(false);
    expect(await redis.get(`test:fsflush:${wx}`)).toBeNull();

    // At eviction the session is not parked and its local copies go, the home included, though the home was never fenced.
    await a.evict("s1");
    expect(a.parked()).toEqual([]);
    expect(existsSync(join(da.homes, "s1"))).toBe(false);
    expect((await latestManifest(store, wx))!.id).toBe(wxLatest);
    // The home was this node's to flush: what it held is stored, not lost.
    expect((await latestManifest(store, hmUnitId("s1")))!.id).toBe(hmLatest);
    a.stop();
    b.stop();
  });
});

describe("review focus 8: the transcript unit id is the same boxed and unboxed", () => {
  test("one folder, one transcript unit: an unboxed node and a boxed node store it under the same id", async () => {
    const root = tmp("tx");
    const d = disk(root, "x");
    mkdirSync(d.cwd, { recursive: true });
    const run = async (boxed: boolean): Promise<string[]> => {
      const store = new LocalObjectStore(tmp(boxed ? "store-boxed" : "store-plain"));
      const n = node({ id: boxed ? "node-boxed" : "node-plain", store, redis: memRedis(), d: { ...d, state: join(root, boxed ? "state-boxed" : "state-plain") }, boxed });
      expect(await n.beforeTurn("s1", "default")).toBe("ok");
      writeFileSync(join(d.cwd, "app.ts"), "export {}");
      mkdirSync(txDirOf(d), { recursive: true });
      writeFileSync(join(txDirOf(d), "s1.jsonl"), '{"turn":1}\n');
      await n.afterTurn("s1", false);
      n.stop();
      return unitsIn(store);
    };
    const plain = await run(false);
    const boxed = await run(true);
    const tx = txUnitId(txDirOf(d));
    expect(plain.filter((u) => u.startsWith("tx-"))).toEqual([tx]);
    expect(boxed.filter((u) => u.startsWith("tx-"))).toEqual([tx]);
    // The workspace unit is shared the same way; only a boxed session has the two packed units on top.
    expect(plain).toEqual([tx, wsUnitId(d.cwd)].sort());
    expect(boxed).toEqual([hmUnitId("s1"), tx, wsUnitId(d.cwd), wxUnitId(d.cwd, D1)].sort());
  });

  test("the folder a box is given for its transcript is that unit's directory, at the same path inside and outside", () => {
    const root = tmp("mount");
    const d = disk(root, "x");
    const configDir = join(root, "config", "s1");
    for (const p of [d.cwd, join(d.claude, "projects"), configDir, join(root, "cli")]) mkdirSync(p, { recursive: true });
    // A session's config directory reaches the persona's transcript tree through a link, as the node lays it out.
    symlinkSync(join(d.claude, "projects"), join(configDir, "projects"));
    const spec = buildBoxSpec({
      sessionId: "s1",
      tenantId: "default",
      persona: "default",
      box: { digest: D1, policy: defaultBoxPolicy() },
      homeDir: join(d.homes, "s1"),
      cwd: d.cwd,
      configDir,
      pluginDirs: [],
      slaudeHome: join(root, "home"),
      cliDir: join(root, "cli"),
    });
    const mount = spec.mounts.find((m) => m.target === txDirOf(d));
    expect(mount).toEqual({ source: txDirOf(d), target: txDirOf(d), mode: "rw" });
    expect(txUnitId(mount!.source)).toBe(txUnitId(txDirOf(d)));
    // The working directory and the config directory keep their node paths too, so the CLI derives the same folder name.
    expect(spec.cwd).toBe(d.cwd);
    for (const p of [d.cwd, configDir]) expect(spec.mounts.find((m) => m.target === p)).toEqual({ source: p, target: p, mode: "rw" });
  });
});
