import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { paths } from "../../src/config/home";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsSync, encodeProjectDir, type BoxFacts, type FsSyncDeps, type QuotaEvent, type RedisLike } from "../../src/node/fs-sync";
import { localPacker } from "../../src/box/boxd/pack";
import { metrics } from "../../src/metrics";
import { makeKeys } from "../../src/queue/keys";
import { LocalObjectStore, hmUnitId, isPackManifest, latestManifest, latestTreeManifest, listAll, wsUnitId, wxUnitId, type ObjectInfo, type ObjectStore, type PutBody } from "../../src/storage";

const dirs: string[] = [];
const tmp = (n: string): string => {
  const d = mkdtempSync(join(tmpdir(), `slaude-fssync-${n}-`));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** An in-memory stand-in for the Redis commands FsSync uses. */
function memRedis(): RedisLike & { keys(): string[] } {
  const m = new Map<string, string>();
  return {
    keys: () => [...m.keys()],
    get: async (k) => m.get(k) ?? null,
    incr: async (k) => {
      const n = Number(m.get(k) ?? 0) + 1;
      m.set(k, String(n));
      return n;
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

/** A store that can be told to fail every write. */
class FlakyStore implements ObjectStore {
  failing = false;
  readonly #inner: ObjectStore;
  constructor(inner: ObjectStore) {
    this.#inner = inner;
  }
  get(key: string, opts?: { range?: [number, number] }) {
    return this.#inner.get(key, opts);
  }
  head(key: string) {
    return this.#inner.head(key);
  }
  /** A key prefix: the first `list` under it fails once (while it is iterated), then the store behaves again. */
  failNextList: string | null = null;
  list(prefix: string, opts?: { after?: string; limit?: number }): AsyncIterable<ObjectInfo> {
    if (this.failNextList !== null && prefix.startsWith(this.failNextList)) {
      this.failNextList = null;
      return {
        // eslint-disable-next-line require-yield
        async *[Symbol.asyncIterator]() {
          throw new Error("list unavailable");
        },
      };
    }
    return this.#inner.list(prefix, opts);
  }
  delete(keys: string[]) {
    return this.#inner.delete(keys);
  }
  async put(key: string, body: PutBody, opts?: { contentType?: string }) {
    if (this.failing) throw new Error("store unavailable");
    return this.#inner.put(key, body, opts);
  }
}

/** Sum of a metric's series whose labels include every given pair (static labels may add others). */
const counter = (name: string, labels: Record<string, string> = {}): number => {
  let total = 0;
  for (const l of metrics.render().split("\n")) {
    if (l.startsWith("#") || !(l.startsWith(`${name}{`) || l.startsWith(`${name} `))) continue;
    if (!Object.entries(labels).every(([k, v]) => l.includes(`${k}="${v}"`))) continue;
    total += Number(l.split(" ").pop());
  }
  return total;
};

interface Machine {
  cwd: string;
  claude: string;
  state: string;
}

let n = 0;
/** One machine's local disk. The same absolute working dir on every machine, as on a cluster, so tests wipe it between "nodes". */
function machine(): Machine {
  const root = tmp("machine");
  const m = { cwd: join(root, "workspaces", `t-${++n}`), claude: join(root, "claude"), state: join(root, "state") };
  return m;
}

function nodeSync(opts: {
  id: string;
  store: ObjectStore;
  redis: RedisLike;
  m: Machine;
  flush?: "turn" | "idle";
  alive?: (id: string) => boolean;
}): FsSync {
  process.env.CLAUDE_CONFIG_DIR = opts.m.claude;
  return new FsSync({
    store: opts.store,
    redis: opts.redis,
    keys: makeKeys("test"), // one key space for every node, as in a cluster
    nodeId: opts.id,
    flush: () => opts.flush ?? "turn",
    workingDirOf: async () => opts.m.cwd,
    nodeAlive: async (id) => opts.alive?.(id) ?? false,
    stateDir: opts.m.state,
  });
}

/** The SDK names its project dir after the directory's real path (macOS temp dirs sit behind a symlink). */
const txDirOf = (m: Machine) => join(m.claude, "projects", encodeProjectDir(existsSync(m.cwd) ? realpathSync(m.cwd) : m.cwd));
const txFile = (m: Machine) => join(txDirOf(m), "sdk-session.jsonl");

/** Wipe a machine's disk: the session lands on a different node. */
function wipe(m: Machine): void {
  rmSync(m.cwd, { recursive: true, force: true });
  rmSync(m.claude, { recursive: true, force: true });
  rmSync(m.state, { recursive: true, force: true });
}

// The suite runs every test file in one process, and tests/setup.ts may set CLAUDE_CONFIG_DIR for all of
// them: put back whatever was there, so no later file sees this one's directories (or loses the setup's).
const ORIGINAL_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
const restoreConfigDir = (): void => {
  if (ORIGINAL_CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CLAUDE_CONFIG_DIR;
};
beforeEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
});
afterEach(restoreConfigDir);
afterAll(restoreConfigDir);

describe("FsSync", () => {
  test("encodeProjectDir matches the SDK's directory naming", () => {
    expect(encodeProjectDir("/Users/a/Code/slaude")).toBe("-Users-a-Code-slaude");
    expect(encodeProjectDir("/data/workspaces/T1-C1-1700000000.000100")).toBe("-data-workspaces-T1-C1-1700000000-000100");
  });

  test("SLAUDE_SYNC_STATE_DIR moves the markers out of SLAUDE_HOME", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const redis = memRedis();
    const m = machine();
    const stateDir = tmp("state-dir");
    process.env.SLAUDE_SYNC_STATE_DIR = stateDir;
    try {
      process.env.CLAUDE_CONFIG_DIR = m.claude;
      // No stateDir dependency: the environment decides, as it does on a node.
      const a = new FsSync({
        store,
        redis,
        keys: makeKeys("test"),
        nodeId: "node-a",
        flush: () => "turn",
        workingDirOf: async () => m.cwd,
        nodeAlive: async () => false,
      });
      await a.beforeTurn("s1", "default");
      writeFileSync(join(m.cwd, "f.txt"), "x");
      await a.afterTurn("s1", false);
      const markers = readdirSync(stateDir).filter((f) => f.endsWith(".json"));
      expect(markers.length).toBe(2); // the workspace and the transcript unit
      expect(existsSync(join(paths.home, ".sync-state"))).toBe(false);
    } finally {
      delete process.env.SLAUDE_SYNC_STATE_DIR;
    }
  });

  test("preparing a unit marks it in use, so a bucket sweeper never takes it from under a resuming session", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const redis = memRedis();
    const m = machine();
    const a = nodeSync({ id: "node-a", store, redis, m });
    await a.beforeTurn("s1", "default");
    expect(redis.keys()).toContain(`test:fsinuse:${wsUnitId(m.cwd)}`);
    a.stop();
  });

  test("a turn on node A is visible, with its transcript, on node B", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const redis = memRedis();
    const m = machine();
    const a = nodeSync({ id: "node-a", store, redis, m });
    expect(await a.beforeTurn("s1", "default")).toBe("ok");
    writeFileSync(join(m.cwd, "notes.md"), "made on A");
    mkdirSync(txDirOf(m), { recursive: true });
    writeFileSync(txFile(m), '{"turn":1}\n');
    await a.afterTurn("s1", false);

    wipe(m);
    const b = nodeSync({ id: "node-b", store, redis, m });
    expect(await b.beforeTurn("s1", "default")).toBe("ok");
    expect(readFileSync(join(m.cwd, "notes.md"), "utf8")).toBe("made on A");
    expect(readFileSync(txFile(m), "utf8")).toBe('{"turn":1}\n');
  });

  test("a warm return to the same node downloads nothing", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const redis = memRedis();
    const m = machine();
    const a = nodeSync({ id: "node-a", store, redis, m });
    await a.beforeTurn("s1", "default");
    writeFileSync(join(m.cwd, "f.txt"), "x");
    await a.afterTurn("s1", false);
    const before = counter("slaude_storage_hydrate_total", { mode: "warm", result: "ok" });
    await a.beforeTurn("s1", "default");
    expect(counter("slaude_storage_hydrate_total", { mode: "warm", result: "ok" })).toBe(before + 2); // ws and tx
  });

  test("with the idle cadence the transcript flushes every turn and the workspace waits for eviction", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const redis = memRedis();
    const m = machine();
    const a = nodeSync({ id: "node-a", store, redis, m, flush: "idle" });
    await a.beforeTurn("s1", "default");
    writeFileSync(join(m.cwd, "work.txt"), "edits");
    mkdirSync(txDirOf(m), { recursive: true });
    writeFileSync(txFile(m), "history\n");
    await a.afterTurn("s1", false);

    const units = [...(await Array.fromAsync(store.list("sessions/")))].map((o) => o.key.split("/")[1]);
    expect(units.some((u) => u!.startsWith("tx-"))).toBe(true);
    expect(units.some((u) => u!.startsWith("ws-"))).toBe(false);

    await a.evict("s1");
    const after = [...(await Array.fromAsync(store.list("sessions/")))].map((o) => o.key.split("/")[1]);
    expect(after.some((u) => u!.startsWith("ws-"))).toBe(true);
    expect(existsSync(m.cwd)).toBe(false); // the local copy is gone after a successful flush
  });

  test("a zombie's flush is fenced and does not clobber the newer node", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const redis = memRedis();
    const ma = machine();
    const mb = { ...ma, claude: ma.claude + "-b", state: ma.state + "-b" };
    const a = nodeSync({ id: "node-a", store, redis, m: ma });
    await a.beforeTurn("s1", "default");
    writeFileSync(join(ma.cwd, "f.txt"), "from A (zombie)");

    // The lock expired and node B took the session: a higher epoch.
    const b = nodeSync({ id: "node-b", store, redis, m: mb });
    await b.beforeTurn("s1", "default");
    writeFileSync(join(mb.cwd, "f.txt"), "from B");
    await b.afterTurn("s1", false);

    const fencedBefore = counter("slaude_storage_flush_total", { result: "fenced" });
    await a.afterTurn("s1", false); // must not throw
    expect(counter("slaude_storage_flush_total", { result: "fenced" })).toBeGreaterThan(fencedBefore);

    wipe(ma);
    const c = nodeSync({ id: "node-c", store, redis, m: ma });
    await c.beforeTurn("s1", "default");
    expect(readFileSync(join(ma.cwd, "f.txt"), "utf8")).toBe("from B");
  });

  test("a lost session lock flushes nothing", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const redis = memRedis();
    const m = machine();
    const a = nodeSync({ id: "node-a", store, redis, m });
    await a.beforeTurn("s1", "default");
    writeFileSync(join(m.cwd, "f.txt"), "x");
    await a.afterTurn("s1", true);
    expect(await latestManifest(store, "ws-none")).toBeNull();
    expect((await Array.fromAsync(store.list("sessions/"))).length).toBe(0);
  });

  test("a failed flush marks needs-flush, keeps the local copy, and retries to success", async () => {
    const flaky = new FlakyStore(new LocalObjectStore(tmp("store")));
    const redis = memRedis();
    const m = machine();
    const a = nodeSync({ id: "node-a", store: flaky, redis, m });
    await a.beforeTurn("s1", "default");
    writeFileSync(join(m.cwd, "precious.txt"), "do not lose");
    flaky.failing = true;
    const errBefore = counter("slaude_storage_flush_total", { result: "error" });
    await a.afterTurn("s1", false); // never throws: the reply is already out
    expect(counter("slaude_storage_flush_total", { result: "error" })).toBeGreaterThan(errBefore);
    expect(counter("slaude_storage_flush_pending")).toBeGreaterThan(0);
    expect(existsSync(join(m.cwd, "precious.txt"))).toBe(true);

    // The same node's next turn flushes before it reads anything back.
    flaky.failing = false;
    expect(await a.beforeTurn("s1", "default")).toBe("ok");
    expect(readFileSync(join(m.cwd, "precious.txt"), "utf8")).toBe("do not lose");
    await a.afterTurn("s1", false);
    expect(counter("slaude_storage_flush_pending")).toBe(0);

    wipe(m);
    const b = nodeSync({ id: "node-b", store: flaky, redis, m });
    await b.beforeTurn("s1", "default");
    expect(readFileSync(join(m.cwd, "precious.txt"), "utf8")).toBe("do not lose");
    a.stop();
  });

  test("another node waits while the owner of unflushed edits is alive", async () => {
    const flaky = new FlakyStore(new LocalObjectStore(tmp("store")));
    const redis = memRedis();
    const ma = machine();
    const a = nodeSync({ id: "node-a", store: flaky, redis, m: ma, alive: (id) => id === "node-a" });
    await a.beforeTurn("s1", "default");
    writeFileSync(join(ma.cwd, "f.txt"), "unflushed");
    flaky.failing = true;
    await a.afterTurn("s1", false);

    const mb = { ...ma, claude: ma.claude + "-b", state: ma.state + "-b" };
    const b = nodeSync({ id: "node-b", store: flaky, redis, m: mb, alive: (id) => id === "node-a" });
    expect(await b.beforeTurn("s1", "default")).toBe("wait");
    a.stop();
  });

  test("another node continues from the last manifest, counting the loss, once the owner is gone", async () => {
    const flaky = new FlakyStore(new LocalObjectStore(tmp("store")));
    const redis = memRedis();
    const ma = machine();
    const a = nodeSync({ id: "node-a", store: flaky, redis, m: ma, alive: () => false });
    await a.beforeTurn("s1", "default");
    writeFileSync(join(ma.cwd, "f.txt"), "committed");
    await a.afterTurn("s1", false);
    await a.beforeTurn("s1", "default");
    writeFileSync(join(ma.cwd, "f.txt"), "never flushed");
    flaky.failing = true;
    await a.afterTurn("s1", false);
    a.stop(); // node A dies

    const lossBefore = counter("slaude_storage_unflushed_loss_total");
    const mb = { ...ma, claude: ma.claude + "-b", state: ma.state + "-b" };
    wipe(mb);
    const b = nodeSync({ id: "node-b", store: flaky, redis, m: mb, alive: () => false });
    expect(await b.beforeTurn("s1", "default")).toBe("ok");
    expect(readFileSync(join(mb.cwd, "f.txt"), "utf8")).toBe("committed");
    // Only the workspace unit had edits the store never got: the transcript had nothing new to put.
    expect(counter("slaude_storage_unflushed_loss_total")).toBe(lossBefore + 1);
  });

  /** Node A leaves unflushed edits behind (its flush failed), then dies; returns what a recreated node on the SAME disk sees. */
  async function deadOwnerOnSameDisk() {
    const flaky = new FlakyStore(new LocalObjectStore(tmp("store")));
    const redis = memRedis();
    const m = machine();
    const a = nodeSync({ id: "node-a", store: flaky, redis, m, alive: () => false });
    await a.beforeTurn("s1", "default");
    writeFileSync(join(m.cwd, "f.txt"), "committed");
    await a.afterTurn("s1", false);
    await a.beforeTurn("s1", "default");
    writeFileSync(join(m.cwd, "f.txt"), "edited after the last flush");
    flaky.failing = true;
    await a.afterTurn("s1", false);
    a.stop(); // the process is gone; its disk and Redis mark remain
    flaky.failing = false;
    return { flaky, redis, m };
  }

  test("a recreated node whose own copy still matches the store does not count a loss, and the edits survive", async () => {
    const { flaky, redis, m } = await deadOwnerOnSameDisk();
    const lossBefore = counter("slaude_storage_unflushed_loss_total");
    const b = nodeSync({ id: "node-b", store: flaky, redis, m, alive: () => false });
    expect(await b.beforeTurn("s1", "default")).toBe("ok");
    expect(counter("slaude_storage_unflushed_loss_total")).toBe(lossBefore);
    expect(readFileSync(join(m.cwd, "f.txt"), "utf8")).toBe("edited after the last flush");
    await b.afterTurn("s1", false);
    // Nothing was lost: a third node on a fresh disk now sees the edit.
    const mc = { ...m, claude: m.claude + "-c", state: m.state + "-c" };
    wipe(mc);
    const c = nodeSync({ id: "node-c", store: flaky, redis, m: mc, alive: () => false });
    await c.beforeTurn("s1", "default");
    expect(readFileSync(join(mc.cwd, "f.txt"), "utf8")).toBe("edited after the last flush");
  });

  test("a mark left by another disk is a loss even when this disk's copy matches the store: the edits are on that other disk", async () => {
    const { flaky, redis, m } = await deadOwnerOnSameDisk();
    // The unit had moved: another node, on another disk, held the newest edits when it died. Its mark names its disk.
    const key = `test:fsflush:${wsUnitId(m.cwd)}`;
    const mark = JSON.parse((await redis.get(key))!) as Record<string, unknown>;
    await redis.set(key, JSON.stringify({ ...mark, node: "node-elsewhere", disk: "some-other-disk" }));
    const lossBefore = counter("slaude_storage_unflushed_loss_total");
    const b = nodeSync({ id: "node-b", store: flaky, redis, m, alive: () => false });
    await b.beforeTurn("s1", "default");
    expect(counter("slaude_storage_unflushed_loss_total")).toBe(lossBefore + 1);
  });

  test("a mark written before disks were identified is treated as a loss, the safe direction", async () => {
    const { flaky, redis, m } = await deadOwnerOnSameDisk();
    const key = `test:fsflush:${wsUnitId(m.cwd)}`;
    const { disk: _ignored, ...legacy } = JSON.parse((await redis.get(key))!) as Record<string, unknown>;
    await redis.set(key, JSON.stringify(legacy));
    const lossBefore = counter("slaude_storage_unflushed_loss_total");
    const b = nodeSync({ id: "node-b", store: flaky, redis, m, alive: () => false });
    await b.beforeTurn("s1", "default");
    expect(counter("slaude_storage_unflushed_loss_total")).toBe(lossBefore + 1);
  });

  test("the mark a failed flush leaves names the disk that holds the edits", async () => {
    const { redis, m } = await deadOwnerOnSameDisk();
    const mark = JSON.parse((await redis.get(`test:fsflush:${wsUnitId(m.cwd)}`))!) as { node?: string; disk?: string };
    expect(mark.node).toBe("node-a");
    expect(typeof mark.disk).toBe("string");
    expect(mark.disk!.length).toBeGreaterThan(8);
  });

  test("a dead owner with a local marker that is not the latest manifest still counts a loss", async () => {
    const { flaky, redis, m } = await deadOwnerOnSameDisk();
    writeFileSync(join(m.state, `${wsUnitId(m.cwd)}.json`), JSON.stringify({ id: "0000000000-000000" }));
    const lossBefore = counter("slaude_storage_unflushed_loss_total");
    const b = nodeSync({ id: "node-b", store: flaky, redis, m, alive: () => false });
    await b.beforeTurn("s1", "default");
    expect(counter("slaude_storage_unflushed_loss_total")).toBe(lossBefore + 1);
  });

  test("when the latest manifest cannot be read, a dead owner is counted as a loss", async () => {
    const { flaky, redis, m } = await deadOwnerOnSameDisk();
    const lossBefore = counter("slaude_storage_unflushed_loss_total");
    const b = nodeSync({ id: "node-b", store: flaky, redis, m, alive: () => false });
    flaky.failNextList = `sessions/${wsUnitId(m.cwd)}/`;
    await b.beforeTurn("s1", "default");
    expect(counter("slaude_storage_unflushed_loss_total")).toBe(lossBefore + 1);
  });

  test("eviction keeps the folder while another session on the node still works in it", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const redis = memRedis();
    const m = machine();
    const a = nodeSync({ id: "node-a", store, redis, m });
    await a.beforeTurn("s1", "default");
    await a.afterTurn("s1", false);
    await a.beforeTurn("s2", "default"); // a second session in the same folder, mid-turn
    writeFileSync(join(m.cwd, "shared.txt"), "shared");
    await a.evict("s1"); // s1 is idle, but its folder is in use
    expect(existsSync(join(m.cwd, "shared.txt"))).toBe(true);
    await a.afterTurn("s2", false);
    await a.evict("s1"); // idle now, but s2 is still tracked in the folder
    expect(existsSync(join(m.cwd, "shared.txt"))).toBe(true);
    await a.evict("s2"); // the last user: the local copy goes
    expect(existsSync(m.cwd)).toBe(false);
  });

  test("an eviction that races a new turn does not delete the directory or wipe the store", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const redis = memRedis();
    const m = machine();
    const a = nodeSync({ id: "node-a", store, redis, m });
    await a.beforeTurn("s1", "default");
    writeFileSync(join(m.cwd, "work.txt"), "committed work");
    await a.afterTurn("s1", false);
    // The idle TTL closes the session and the heartbeat starts evicting; a new job for it starts first.
    expect(await a.beforeTurn("s1", "default")).toBe("ok");
    await a.evict("s1"); // the session is active again: nothing to do
    expect(readFileSync(join(m.cwd, "work.txt"), "utf8")).toBe("committed work");
    await a.afterTurn("s1", false);
    wipe(m);
    const b = nodeSync({ id: "node-b", store, redis, m });
    await b.beforeTurn("s1", "default");
    expect(readFileSync(join(m.cwd, "work.txt"), "utf8")).toBe("committed work");
  });

  test("a directory deleted under a tracked session is not committed as an empty tree", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const redis = memRedis();
    const m = machine();
    const a = nodeSync({ id: "node-a", store, redis, m });
    await a.beforeTurn("s1", "default");
    writeFileSync(join(m.cwd, "work.txt"), "committed work");
    await a.afterTurn("s1", false);
    await a.beforeTurn("s1", "default");
    rmSync(m.cwd, { recursive: true, force: true }); // something removed it mid-turn
    await a.afterTurn("s1", false);
    wipe(m);
    const b = nodeSync({ id: "node-b", store, redis, m });
    await b.beforeTurn("s1", "default");
    expect(readFileSync(join(m.cwd, "work.txt"), "utf8")).toBe("committed work");
  });

  test("a hydrate that fails drops the session and is never flushed over newer state", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const redis = memRedis();
    const ma = machine();
    const mb = { ...ma, claude: ma.claude + "-b", state: ma.state + "-b" };
    const b = nodeSync({ id: "node-b", store, redis, m: mb });
    await b.beforeTurn("s1", "default");
    writeFileSync(join(mb.cwd, "a.txt"), "from B");
    writeFileSync(join(mb.cwd, "b.txt"), "from B too");
    await b.afterTurn("s1", false);

    const a = nodeSync({ id: "node-a", store, redis, m: ma });
    wipe(ma);
    // The store loses a blob, so A's hydrate dies part way.
    const files = await Array.fromAsync(store.list("sessions/"));
    const blob = files.find((o) => o.key.includes("/blobs/") && o.key.includes("ws-"));
    await store.delete([blob!.key]);
    await expect(a.beforeTurn("s1", "default")).rejects.toThrow();
    expect(a.tracked()).toEqual([]); // nothing of it will be flushed
    await a.evict("s1");
    await a.drain();
  });

  test("after Redis loses the epoch counter, new epochs start above what is stored", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const redis = memRedis();
    const m = machine();
    const a = nodeSync({ id: "node-a", store, redis, m });
    for (let i = 0; i < 3; i++) {
      await a.beforeTurn("s1", "default");
      writeFileSync(join(m.cwd, "f.txt"), `turn ${i}`);
      await a.afterTurn("s1", false);
    }
    // A fresh Redis: the counter restarts at 0, below the stored manifests' epoch.
    const fresh = memRedis();
    const b = nodeSync({ id: "node-b", store, redis: fresh, m });
    await b.beforeTurn("s1", "default");
    writeFileSync(join(m.cwd, "f.txt"), "after the redis loss");
    const fencedBefore = counter("slaude_storage_flush_total", { result: "fenced" });
    await b.afterTurn("s1", false);
    expect(counter("slaude_storage_flush_total", { result: "fenced" })).toBe(fencedBefore); // not silently discarded
    wipe(m);
    const c = nodeSync({ id: "node-c", store, redis: fresh, m });
    await c.beforeTurn("s1", "default");
    expect(readFileSync(join(m.cwd, "f.txt"), "utf8")).toBe("after the redis loss");
  });

  test("clearing a flushed unit never deletes another node's needs-flush mark", async () => {
    const flaky = new FlakyStore(new LocalObjectStore(tmp("store")));
    const redis = memRedis();
    const m = machine();
    const a = nodeSync({ id: "node-a", store: flaky, redis, m });
    await a.beforeTurn("s1", "default");
    writeFileSync(join(m.cwd, "f.txt"), "x");
    flaky.failing = true;
    await a.afterTurn("s1", false);
    // Another node has since taken the unit and failed to flush too: its mark replaces ours.
    const marks = redis.keys().filter((k) => k.includes(":fsflush:"));
    expect(marks.length).toBeGreaterThan(0);
    for (const k of marks) await redis.set(k, JSON.stringify({ node: "node-c", since: Date.now() }));
    flaky.failing = false;
    await a.drain(); // A's flush now succeeds and clears its own pending entry
    for (const k of marks) expect(JSON.parse((await redis.get(k))!).node).toBe("node-c");
  });

  test("eviction that cannot delete a leftover file is logged, never raised", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const redis = memRedis();
    const m = machine();
    const a = nodeSync({ id: "node-a", store, redis, m });
    await a.beforeTurn("s1", "default");
    // A directory a different (root) process left behind: the node may not unlink what is inside it.
    const locked = join(m.cwd, "left-by-root");
    mkdirSync(locked);
    writeFileSync(join(locked, "f.txt"), "x");
    chmodSync(locked, 0o500);
    await a.afterTurn("s1", false);
    try {
      await expect(a.evict("s1")).resolves.toBeUndefined();
      // The copy is still there, so the marker that says what it matches must stay: removing it would make the
      // next hydrate treat a leftover tree as unknown.
      if (process.getuid && process.getuid() !== 0) expect(readdirSync(m.state).filter((f) => f.endsWith(".json")).length).toBeGreaterThan(0);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  test("the first turn resolves a symlinked workspaces path, so the transcript dir is the one the SDK writes", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const redis = memRedis();
    const real = realpathSync(tmp("real-root"));
    const link = join(tmp("link-parent"), "link");
    symlinkSync(real, link);
    const m = machine();
    m.cwd = join(link, "workspaces", "t-1"); // does not exist yet: the node creates it on its first hydrate
    const a = nodeSync({ id: "node-a", store, redis, m });
    await a.beforeTurn("s1", "default");
    // The SDK names its project dir after the real path.
    const txDir = join(m.claude, "projects", encodeProjectDir(join(real, "workspaces", "t-1")));
    mkdirSync(txDir, { recursive: true });
    writeFileSync(join(txDir, "sdk.jsonl"), "history\n");
    await a.afterTurn("s1", false);

    rmSync(real, { recursive: true, force: true });
    mkdirSync(real);
    rmSync(m.claude, { recursive: true, force: true });
    rmSync(m.state, { recursive: true, force: true });
    const b = nodeSync({ id: "node-b", store, redis, m });
    await b.beforeTurn("s1", "default");
    expect(readFileSync(join(txDir, "sdk.jsonl"), "utf8")).toBe("history\n");
  });

  test("overlapping flushes of one unit run one after the other", async () => {
    const inner = new LocalObjectStore(tmp("store"));
    let inFlight = 0;
    let maxInFlight = 0;
    const slow: ObjectStore = {
      get: (k, o) => inner.get(k, o),
      head: (k) => inner.head(k),
      list: (p, o) => inner.list(p, o),
      delete: (k) => inner.delete(k),
      put: async (k, b) => {
        if (k.includes("/manifest/")) {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await Bun.sleep(30);
          inFlight--;
        }
        return inner.put(k, b);
      },
    };
    const redis = memRedis();
    const m = machine();
    const a = nodeSync({ id: "node-a", store: slow, redis, m });
    await a.beforeTurn("s1", "default");
    writeFileSync(join(m.cwd, "f.txt"), "v1");
    await Promise.all([a.afterTurn("s1", false), a.drain()]);
    expect(maxInFlight).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Boxed sessions: the packed units (wx, hm) and parking
// ---------------------------------------------------------------------------

const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;

interface BoxMachine extends Machine {
  root: string;
  homes: string;
  spool: string;
}

function boxMachine(): BoxMachine {
  const root = tmp("boxmachine");
  return { root, cwd: join(root, "workspaces", `t-${++n}`), claude: join(root, "claude"), state: join(root, "state"), homes: join(root, "homes"), spool: join(root, "spool") };
}

const DISK_PARTS = ["workspaces", "claude", "state", "homes", "spool"];
/** Take a machine's disk away (another node's disk takes its place at the same paths), and bring it back. */
function swapOut(m: BoxMachine, tag: string): void {
  for (const part of DISK_PARTS) if (existsSync(join(m.root, part))) renameSync(join(m.root, part), join(m.root, `${part}.${tag}`));
}
function swapIn(m: BoxMachine, tag: string): void {
  for (const part of DISK_PARTS) if (existsSync(join(m.root, `${part}.${tag}`))) renameSync(join(m.root, `${part}.${tag}`), join(m.root, part));
}

const homeOf = (m: BoxMachine, sessionId: string): string => join(m.homes, sessionId);

function boxNode(opts: {
  id: string;
  store: ObjectStore;
  redis: RedisLike;
  m: BoxMachine;
  flush?: "turn" | "idle";
  alive?: (id: string) => boolean;
  digestOf?: (sessionId: string) => string | undefined;
  cwdOf?: (sessionId: string) => string;
  facts?: Partial<BoxFacts>;
  deps?: Partial<FsSyncDeps>;
}): FsSync {
  process.env.CLAUDE_CONFIG_DIR = opts.m.claude;
  return new FsSync({
    store: opts.store,
    redis: opts.redis,
    keys: makeKeys("test"),
    nodeId: opts.id,
    flush: () => opts.flush ?? "turn",
    workingDirOf: async (sid) => opts.cwdOf?.(sid) ?? opts.m.cwd,
    nodeAlive: async (id) => opts.alive?.(id) ?? false,
    stateDir: opts.m.state,
    packer: localPacker({ spoolDir: opts.m.spool }),
    boxOf: (sid) => {
      const digest = opts.digestOf ? opts.digestOf(sid) : D1;
      return digest === undefined ? undefined : { digest, homeDir: homeOf(opts.m, sid), ...opts.facts };
    },
    ...opts.deps,
  });
}

/** A store that counts blob downloads and can fail every write. */
class CountingStore extends FlakyStore {
  blobGets = 0;
  override get(key: string, opts?: { range?: [number, number] }) {
    if (key.includes("/blobs/")) this.blobGets++;
    return super.get(key, opts);
  }
}

const unitsIn = async (store: ObjectStore): Promise<string[]> => [...new Set((await listAll(store, "sessions/")).map((o) => o.key.split("/")[1]!))].sort();

function writeInstalls(m: BoxMachine, sessionId: string, tag: string): void {
  mkdirSync(join(m.cwd, "node_modules", tag), { recursive: true });
  writeFileSync(join(m.cwd, "node_modules", tag, "index.js"), `module.exports = "${tag}";`);
  mkdirSync(join(homeOf(m, sessionId), ".npm-global", "bin"), { recursive: true });
  writeFileSync(join(homeOf(m, sessionId), ".npm-global", "bin", tag), `#!/bin/sh\necho ${tag}\n`);
  chmodSync(join(homeOf(m, sessionId), ".npm-global", "bin", tag), 0o755);
}

describe("FsSync, boxed sessions", () => {
  test("a boxed turn syncs four units, and node B gets the workspace, the transcript, the installs and the home", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const redis = memRedis();
    const m = boxMachine();
    const a = boxNode({ id: "node-a", store, redis, m });
    expect(await a.beforeTurn("s1", "default")).toBe("ok");
    expect(existsSync(homeOf(m, "s1"))).toBe(true);
    writeFileSync(join(m.cwd, "app.ts"), "export {}");
    writeInstalls(m, "s1", "left-pad");
    mkdirSync(txDirOf(m), { recursive: true });
    writeFileSync(txFile(m), '{"turn":1}\n');
    await a.afterTurn("s1", false);

    const ws = wsUnitId(m.cwd);
    const wx = wxUnitId(m.cwd, D1);
    const hm = hmUnitId("s1");
    const all = await unitsIn(store);
    expect(all).toContain(ws);
    expect(all).toContain(wx);
    expect(all).toContain(hm);
    expect(all.length).toBe(4);
    // The two workspace units split the directory: nothing is stored twice, nothing is left out.
    const wsKeys = Object.keys((await latestTreeManifest(store, ws))!.manifest.files);
    expect(wsKeys).toEqual(["ws/app.ts"]);
    expect(isPackManifest((await latestManifest(store, wx))!.manifest)).toBe(true);
    expect(isPackManifest((await latestManifest(store, hm))!.manifest)).toBe(true);
    for (const u of [wx, hm]) expect(redis.keys()).toContain(`test:fsinuse:${u}`);

    // A second flush of the same state writes nothing for any unit.
    const before = (await listAll(store, "sessions/")).length;
    await a.beforeTurn("s1", "default");
    await a.afterTurn("s1", false);
    expect((await listAll(store, "sessions/")).length).toBe(before);

    swapOut(m, "a");
    const b = boxNode({ id: "node-b", store, redis, m });
    expect(await b.beforeTurn("s1", "default")).toBe("ok");
    expect(readFileSync(join(m.cwd, "app.ts"), "utf8")).toBe("export {}");
    expect(readFileSync(join(m.cwd, "node_modules", "left-pad", "index.js"), "utf8")).toContain("left-pad");
    const tool = join(homeOf(m, "s1"), ".npm-global", "bin", "left-pad");
    expect(readFileSync(tool, "utf8")).toContain("echo left-pad");
    expect(lstatSync(tool).mode & 0o777).toBe(0o755);
    expect(readFileSync(txFile(m), "utf8")).toBe('{"turn":1}\n');
    a.stop();
    b.stop();
  });

  test("a session with no box keeps two units and is evicted as before, on the same node that runs boxes", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const redis = memRedis();
    const m = boxMachine();
    const a = boxNode({ id: "node-a", store, redis, m, digestOf: () => undefined });
    await a.beforeTurn("s1", "default");
    writeFileSync(join(m.cwd, "f.txt"), "x");
    mkdirSync(join(m.cwd, "node_modules"), { recursive: true });
    await a.afterTurn("s1", false);
    expect((await unitsIn(store)).length).toBe(2);
    await a.evict("s1");
    expect(existsSync(m.cwd)).toBe(false);
    expect(a.parked()).toEqual([]);
    expect(existsSync(homeOf(m, "s1"))).toBe(false);
  });

  test("with the idle cadence the packed units wait for eviction, like the workspace", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const redis = memRedis();
    const m = boxMachine();
    const a = boxNode({ id: "node-a", store, redis, m, flush: "idle" });
    await a.beforeTurn("s1", "default");
    writeInstalls(m, "s1", "tool");
    await a.afterTurn("s1", false);
    expect(await latestManifest(store, hmUnitId("s1"))).toBeNull();
    expect(await latestManifest(store, wxUnitId(m.cwd, D1))).toBeNull();
    await a.evict("s1");
    expect(await latestManifest(store, hmUnitId("s1"))).not.toBeNull();
    expect(await latestManifest(store, wxUnitId(m.cwd, D1))).not.toBeNull();
  });

  test("a failed home flush marks needs-flush, a live owner makes another node wait, and the owner's next turn flushes first", async () => {
    const flaky = new FlakyStore(new LocalObjectStore(tmp("store")));
    const redis = memRedis();
    const m = boxMachine();
    const a = boxNode({ id: "node-a", store: flaky, redis, m, alive: (id) => id === "node-a" });
    await a.beforeTurn("s1", "default");
    writeInstalls(m, "s1", "first");
    await a.afterTurn("s1", false);

    await a.beforeTurn("s1", "default");
    writeFileSync(join(homeOf(m, "s1"), ".bash_history"), "npm i -g precious\n");
    flaky.failing = true;
    await a.afterTurn("s1", false);
    const mark = JSON.parse((await redis.get(`test:fsflush:${hmUnitId("s1")}`))!) as { node: string; disk: string };
    expect(mark.node).toBe("node-a");
    expect(mark.disk).toBe(readFileSync(join(m.state, "disk-id"), "utf8"));
    expect(readFileSync(join(homeOf(m, "s1"), ".bash_history"), "utf8")).toContain("precious");

    const mb = { ...m, claude: `${m.claude}-b`, state: `${m.state}-b`, homes: `${m.homes}-b`, spool: `${m.spool}-b` };
    const b = boxNode({ id: "node-b", store: flaky, redis, m: mb, alive: (id) => id === "node-a" });
    expect(await b.beforeTurn("s1", "default")).toBe("wait");
    expect(b.tracked()).toEqual([]);

    flaky.failing = false;
    process.env.CLAUDE_CONFIG_DIR = m.claude;
    expect(await a.beforeTurn("s1", "default")).toBe("ok");
    await a.afterTurn("s1", false);
    expect(await redis.get(`test:fsflush:${hmUnitId("s1")}`)).toBeNull();
    swapOut(m, "a");
    const c = boxNode({ id: "node-c", store: flaky, redis, m });
    await c.beforeTurn("s1", "default");
    expect(readFileSync(join(homeOf(m, "s1"), ".bash_history"), "utf8")).toContain("precious");
    a.stop();
    b.stop();
    c.stop();
  });

  test("when the owner of unflushed home edits is gone, another node continues from the last flush and counts the loss", async () => {
    const flaky = new FlakyStore(new LocalObjectStore(tmp("store")));
    const redis = memRedis();
    const m = boxMachine();
    const a = boxNode({ id: "node-a", store: flaky, redis, m });
    await a.beforeTurn("s1", "default");
    writeInstalls(m, "s1", "flushed");
    await a.afterTurn("s1", false);
    await a.beforeTurn("s1", "default");
    writeInstalls(m, "s1", "unflushed");
    flaky.failing = true;
    await a.afterTurn("s1", false);
    a.stop(); // the node dies with the edits on its disk
    flaky.failing = false;

    swapOut(m, "a");
    const lossBefore = counter("slaude_storage_unflushed_loss_total");
    const b = boxNode({ id: "node-b", store: flaky, redis, m, alive: () => false });
    expect(await b.beforeTurn("s1", "default")).toBe("ok");
    // One loss per unit that had unflushed edits: the extras and the home.
    expect(counter("slaude_storage_unflushed_loss_total") - lossBefore).toBe(2);
    const bin = join(homeOf(m, "s1"), ".npm-global", "bin");
    expect(readdirSync(bin)).toEqual(["flushed"]);
    expect(readdirSync(join(m.cwd, "node_modules"))).toEqual(["flushed"]);
    b.stop();
  });

  test("a recreated process on the same disk recovers a home it had not flushed", async () => {
    const flaky = new FlakyStore(new LocalObjectStore(tmp("store")));
    const redis = memRedis();
    const m = boxMachine();
    const a = boxNode({ id: "node-a", store: flaky, redis, m });
    await a.beforeTurn("s1", "default");
    writeInstalls(m, "s1", "flushed");
    await a.afterTurn("s1", false);
    await a.beforeTurn("s1", "default");
    writeInstalls(m, "s1", "kept");
    flaky.failing = true;
    await a.afterTurn("s1", false);
    a.stop();
    flaky.failing = false;

    const lossBefore = counter("slaude_storage_unflushed_loss_total");
    const a2 = boxNode({ id: "node-a2", store: flaky, redis, m, alive: () => false });
    expect(await a2.beforeTurn("s1", "default")).toBe("ok");
    expect(counter("slaude_storage_unflushed_loss_total")).toBe(lossBefore);
    expect(readdirSync(join(homeOf(m, "s1"), ".npm-global", "bin")).sort()).toEqual(["flushed", "kept"]);
    await a2.afterTurn("s1", false);
    // The recovered edits went up as a delta on the stored layers, not as a second full copy.
    const hm = (await latestManifest(flaky, hmUnitId("s1")))!.manifest;
    expect(isPackManifest(hm) && hm.layers.length).toBe(2);

    swapOut(m, "a");
    const b = boxNode({ id: "node-b", store: flaky, redis, m });
    await b.beforeTurn("s1", "default");
    expect(readdirSync(join(homeOf(m, "s1"), ".npm-global", "bin")).sort()).toEqual(["flushed", "kept"]);
    expect(readdirSync(join(m.cwd, "node_modules")).sort()).toEqual(["flushed", "kept"]);
    a2.stop();
    b.stop();
  });

  test("two sessions in one folder on the same image share the extras unit and keep separate homes", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const redis = memRedis();
    const m = boxMachine();
    const a = boxNode({ id: "node-a", store, redis, m });
    await a.beforeTurn("s1", "default");
    writeInstalls(m, "s1", "one");
    await a.afterTurn("s1", false);
    await a.beforeTurn("s2", "default");
    expect(existsSync(join(m.cwd, "node_modules", "one"))).toBe(true);
    writeInstalls(m, "s2", "two");
    await a.afterTurn("s2", false);

    const all = await unitsIn(store);
    expect(all.filter((u) => u.startsWith("wx-"))).toEqual([wxUnitId(m.cwd, D1)]);
    expect(all.filter((u) => u.startsWith("hm-")).sort()).toEqual([hmUnitId("s1"), hmUnitId("s2")]);

    // One session leaving does not take the folder from the other.
    await a.evict("s1");
    expect(readdirSync(join(m.cwd, "node_modules")).sort()).toEqual(["one", "two"]);

    swapOut(m, "a");
    const b = boxNode({ id: "node-b", store, redis, m });
    await b.beforeTurn("s2", "default");
    expect(readdirSync(join(m.cwd, "node_modules")).sort()).toEqual(["one", "two"]);
    expect(readdirSync(join(homeOf(m, "s2"), ".npm-global", "bin"))).toEqual(["two"]);
    a.stop();
    b.stop();
  });

  test("two sessions in one folder on different images get different extras units, and neither sees the other's installs", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const redis = memRedis();
    const m = boxMachine();
    const digestOf = (sid: string) => (sid === "s1" ? D1 : D2);
    const a = boxNode({ id: "node-a", store, redis, m, digestOf });
    await a.beforeTurn("s1", "default");
    writeFileSync(join(m.cwd, "shared.ts"), "both see this");
    writeInstalls(m, "s1", "built-for-one");
    await a.afterTurn("s1", false);

    // The refreshed session starts clean in the same folder: the old image's installs are not carried over.
    await a.beforeTurn("s2", "default");
    expect(existsSync(join(m.cwd, "node_modules"))).toBe(false);
    expect(readFileSync(join(m.cwd, "shared.ts"), "utf8")).toBe("both see this");
    writeInstalls(m, "s2", "built-for-two");
    await a.afterTurn("s2", false);

    const wx1 = wxUnitId(m.cwd, D1);
    const wx2 = wxUnitId(m.cwd, D2);
    expect(wx1).not.toBe(wx2);
    expect((await unitsIn(store)).filter((u) => u.startsWith("wx-")).sort()).toEqual([wx1, wx2].sort());

    // Back to the first session on the same node: its own installs return, the other's are gone from the folder.
    await a.beforeTurn("s1", "default");
    expect(readdirSync(join(m.cwd, "node_modules"))).toEqual(["built-for-one"]);
    await a.afterTurn("s1", false);
    expect(readdirSync(join(m.cwd, "node_modules"))).toEqual(["built-for-one"]);

    swapOut(m, "a");
    const b = boxNode({ id: "node-b", store, redis, m, digestOf });
    await b.beforeTurn("s2", "default");
    expect(readdirSync(join(m.cwd, "node_modules"))).toEqual(["built-for-two"]);
    await b.afterTurn("s2", false);
    await b.beforeTurn("s1", "default");
    expect(readdirSync(join(m.cwd, "node_modules"))).toEqual(["built-for-one"]);
    a.stop();
    b.stop();
  });

  test("an idle boxed session is parked: its copies stay, and its return downloads nothing", async () => {
    const store = new CountingStore(new LocalObjectStore(tmp("store")));
    const redis = memRedis();
    const m = boxMachine();
    const hints: [string, boolean][] = [];
    const a = boxNode({ id: "node-a", store, redis, m, deps: { onPark: (sid, parked) => hints.push([sid, parked]) } });
    await a.beforeTurn("s1", "default");
    writeFileSync(join(m.cwd, "app.ts"), "export {}");
    writeInstalls(m, "s1", "tool");
    mkdirSync(txDirOf(m), { recursive: true });
    writeFileSync(txFile(m), '{"turn":1}\n');
    await a.afterTurn("s1", false);
    await a.evict("s1");

    expect(a.tracked()).toEqual([]);
    expect(a.parked()).toEqual(["s1"]);
    expect(hints).toEqual([["s1", true]]);
    expect(a.parkedBytes()).toBeGreaterThan(0);
    expect(existsSync(join(m.cwd, "app.ts"))).toBe(true);
    expect(existsSync(join(m.cwd, "node_modules", "tool", "index.js"))).toBe(true);
    expect(existsSync(join(homeOf(m, "s1"), ".npm-global", "bin", "tool"))).toBe(true);
    expect(existsSync(txFile(m))).toBe(true);

    store.blobGets = 0;
    const cold = counter("slaude_storage_hydrate_total", { mode: "cold" });
    const objects = (await listAll(store, "sessions/")).length;
    expect(await a.beforeTurn("s1", "default")).toBe("ok");
    expect(store.blobGets).toBe(0);
    expect(counter("slaude_storage_hydrate_total", { mode: "cold" })).toBe(cold);
    expect(a.parked()).toEqual([]);
    expect(a.tracked()).toEqual(["s1"]);
    expect(hints).toEqual([
      ["s1", true],
      ["s1", false],
    ]);
    await a.afterTurn("s1", false);
    expect((await listAll(store, "sessions/")).length).toBe(objects); // and the unchanged copies flush nothing
    a.stop();
  });

  test("the park table survives a restart of the process on the same disk", async () => {
    const store = new CountingStore(new LocalObjectStore(tmp("store")));
    const redis = memRedis();
    const m = boxMachine();
    const a = boxNode({ id: "node-a", store, redis, m });
    await a.beforeTurn("s1", "default");
    writeInstalls(m, "s1", "tool");
    await a.afterTurn("s1", false);
    await a.evict("s1");
    a.stop();

    const a2 = boxNode({ id: "node-a", store, redis, m });
    expect(a2.parked()).toEqual(["s1"]);
    store.blobGets = 0;
    await a2.beforeTurn("s1", "default");
    expect(store.blobGets).toBe(0);
    expect(a2.parked()).toEqual([]);
    await a2.afterTurn("s1", false);
    await a2.evict("s1");
    await a2.dropParked("s1");
    expect(existsSync(homeOf(m, "s1"))).toBe(false);
    expect(existsSync(m.cwd)).toBe(false);
    a2.stop();
  });

  test("a parked copy that another node superseded is replaced on return", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const redis = memRedis();
    const m = boxMachine();
    const a = boxNode({ id: "node-a", store, redis, m });
    await a.beforeTurn("s1", "default");
    writeInstalls(m, "s1", "old");
    writeFileSync(join(homeOf(m, "s1"), "notes"), "from A");
    await a.afterTurn("s1", false);
    await a.evict("s1");
    expect(a.parked()).toEqual(["s1"]);

    swapOut(m, "a");
    const b = boxNode({ id: "node-b", store, redis, m });
    await b.beforeTurn("s1", "default");
    writeFileSync(join(homeOf(m, "s1"), "notes"), "from B, later");
    rmSync(join(homeOf(m, "s1"), ".npm-global"), { recursive: true });
    rmSync(join(m.cwd, "node_modules", "old"), { recursive: true });
    writeInstalls(m, "s1", "new");
    await b.afterTurn("s1", false);
    await b.evict("s1");
    swapOut(m, "b");
    swapIn(m, "a");

    // A's disk still holds its parked copy, with markers that no longer name the latest manifests.
    expect(readFileSync(join(homeOf(m, "s1"), "notes"), "utf8")).toBe("from A");
    process.env.CLAUDE_CONFIG_DIR = m.claude;
    expect(await a.beforeTurn("s1", "default")).toBe("ok");
    expect(readFileSync(join(homeOf(m, "s1"), "notes"), "utf8")).toBe("from B, later");
    expect(readdirSync(join(homeOf(m, "s1"), ".npm-global", "bin"))).toEqual(["new"]);
    expect(readdirSync(join(m.cwd, "node_modules"))).toEqual(["new"]);
    a.stop();
    b.stop();
  });

  test("the pruner drops the least recently used parked session above the budget", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const redis = memRedis();
    const m = boxMachine();
    let clock = 1000;
    const hints: [string, boolean][] = [];
    const a = boxNode({
      id: "node-a",
      store,
      redis,
      m,
      cwdOf: (sid) => join(m.root, "workspaces", sid),
      deps: { now: () => clock, parkBudgetMb: 1.5, onPark: (sid, parked) => hints.push([sid, parked]) },
    });
    for (const sid of ["s1", "s2", "s3"]) {
      clock += 1000;
      await a.beforeTurn(sid, "default");
      writeFileSync(join(homeOf(m, sid), "cache.bin"), Buffer.alloc(600_000, 1));
      await a.afterTurn(sid, false);
      await a.evict(sid);
    }
    // Two homes fit the budget, three do not: the oldest goes. It was flushed, so nothing is lost.
    expect(a.parked()).toEqual(["s2", "s3"]);
    expect(existsSync(homeOf(m, "s1"))).toBe(false);
    expect(existsSync(join(m.root, "workspaces", "s1"))).toBe(false);
    expect(existsSync(join(m.state, `${hmUnitId("s1")}.json`))).toBe(false);
    expect(existsSync(join(homeOf(m, "s2"), "cache.bin"))).toBe(true);
    expect(hints.filter(([, parked]) => !parked)).toEqual([["s1", false]]);
    expect(a.parkedBytes()).toBeLessThanOrEqual(1.5 * 1024 * 1024);

    // Using a parked session makes it the most recent: the next one to go is s3.
    clock += 1000;
    await a.beforeTurn("s2", "default");
    await a.afterTurn("s2", false);
    await a.evict("s2");
    clock += 1000;
    await a.beforeTurn("s4", "default");
    writeFileSync(join(homeOf(m, "s4"), "cache.bin"), Buffer.alloc(600_000, 1));
    await a.afterTurn("s4", false);
    await a.evict("s4");
    expect(a.parked().sort()).toEqual(["s2", "s4"]);

    swapOut(m, "a");
    const b = boxNode({ id: "node-b", store, redis, m, cwdOf: (sid) => join(m.root, "workspaces", sid) });
    await b.beforeTurn("s1", "default");
    expect(lstatSync(join(homeOf(m, "s1"), "cache.bin")).size).toBe(600_000);
    a.stop();
    b.stop();
  });

  test("the pruner never drops a parked session with an unflushed unit, and drops on short disk", async () => {
    const flaky = new FlakyStore(new LocalObjectStore(tmp("store")));
    const redis = memRedis();
    const m = boxMachine();
    let clock = 1000;
    let freeMb = 10_000;
    const a = boxNode({
      id: "node-a",
      store: flaky,
      redis,
      m,
      cwdOf: (sid) => join(m.root, "workspaces", sid),
      deps: { now: () => clock, parkBudgetMb: 1.5, freeDiskMb: () => freeMb, minFreeDiskMb: 500 },
    });
    await a.beforeTurn("s1", "default");
    writeFileSync(join(homeOf(m, "s1"), "cache.bin"), Buffer.alloc(600_000, 1));
    await a.afterTurn("s1", false);
    await a.beforeTurn("s1", "default");
    writeFileSync(join(homeOf(m, "s1"), "unflushed.txt"), "only on this disk");
    flaky.failing = true;
    await a.afterTurn("s1", false);
    await a.evict("s1"); // parked, with a flush still owed
    flaky.failing = false;
    expect(a.parked()).toEqual(["s1"]);

    for (const sid of ["s2", "s3"]) {
      clock += 1000;
      await a.beforeTurn(sid, "default");
      writeFileSync(join(homeOf(m, sid), "cache.bin"), Buffer.alloc(600_000, 1));
      await a.afterTurn(sid, false);
      await a.evict(sid);
    }
    // s1 is the oldest, but its edits exist nowhere else: s2 goes instead.
    expect(a.parked().sort()).toEqual(["s1", "s3"]);
    expect(readFileSync(join(homeOf(m, "s1"), "unflushed.txt"), "utf8")).toBe("only on this disk");
    expect(existsSync(homeOf(m, "s2"))).toBe(false);

    // Free disk runs short: everything that is safe to drop goes, the unflushed one stays.
    freeMb = 100;
    expect(await a.prune()).toEqual(["s3"]);
    expect(a.parked()).toEqual(["s1"]);
    expect(existsSync(join(homeOf(m, "s1"), "unflushed.txt"))).toBe(true);
    a.stop();
  });

  test("a fenced home flush commits nothing, tells the caller, and the copy is discarded instead of parked", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const redis = memRedis();
    const m = boxMachine();
    const fenced: [string, string[]][] = [];
    const a = boxNode({ id: "node-a", store, redis, m, deps: { onFenced: (unit, sessions) => fenced.push([unit, sessions]) } });
    await a.beforeTurn("s1", "default");
    writeFileSync(join(homeOf(m, "s1"), "notes"), "v1");
    await a.afterTurn("s1", false);

    // Node B takes the session (A lost its lock and does not know yet). B has its own disk for the home.
    const mb = { ...m, state: `${m.state}-b`, homes: `${m.homes}-b`, spool: `${m.spool}-b` };
    const b = boxNode({ id: "node-b", store, redis, m: mb });
    await b.beforeTurn("s1", "default");
    writeFileSync(join(homeOf(mb, "s1"), "notes"), "v2 from B");
    await b.afterTurn("s1", false);
    const latest = (await latestManifest(store, hmUnitId("s1")))!.id;

    writeFileSync(join(homeOf(m, "s1"), "notes"), "zombie write");
    const fencedBefore = counter("slaude_storage_flush_total", { result: "fenced" });
    await a.afterTurn("s1", false);
    expect(counter("slaude_storage_flush_total", { result: "fenced" })).toBeGreaterThan(fencedBefore);
    expect((await latestManifest(store, hmUnitId("s1")))!.id).toBe(latest);
    expect(fenced.map(([unit]) => unit)).toContain(hmUnitId("s1"));
    expect(fenced.find(([unit]) => unit === hmUnitId("s1"))![1]).toEqual(["s1"]);
    expect(await redis.get(`test:fsflush:${hmUnitId("s1")}`)).toBeNull();
    // The marker and the index are gone: this copy can never pass for the stored state.
    expect(existsSync(join(m.state, `${hmUnitId("s1")}.json`))).toBe(false);
    expect(existsSync(join(m.state, `${hmUnitId("s1")}.index.json`))).toBe(false);

    await a.evict("s1");
    expect(a.parked()).toEqual([]);
    expect(existsSync(homeOf(m, "s1"))).toBe(false);
    expect((await latestManifest(store, hmUnitId("s1")))!.id).toBe(latest);
    a.stop();
    b.stop();
  });

  test("a session whose lock was lost is not parked", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const redis = memRedis();
    const m = boxMachine();
    const a = boxNode({ id: "node-a", store, redis, m });
    await a.beforeTurn("s1", "default");
    writeFileSync(join(homeOf(m, "s1"), "notes"), "v1");
    await a.afterTurn("s1", true);
    expect(await latestManifest(store, hmUnitId("s1"))).toBeNull(); // a lost lock flushes nothing
    await a.evict("s1");
    expect(a.parked()).toEqual([]);
    expect(existsSync(homeOf(m, "s1"))).toBe(false);
    a.stop();
  });

  test("a home over its soft limit is reported and stored; over twice the limit it is refused and stays local", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const redis = memRedis();
    const m = boxMachine();
    const events: QuotaEvent[] = [];
    const a = boxNode({ id: "node-a", store, redis, m, facts: { homeMb: 1000 / (1024 * 1024) }, deps: { onQuota: (e) => events.push(e) } });
    await a.beforeTurn("s1", "default");
    writeFileSync(join(homeOf(m, "s1"), "a"), "x".repeat(500));
    await a.afterTurn("s1", false);
    expect(events).toEqual([]);

    await a.beforeTurn("s1", "default");
    writeFileSync(join(homeOf(m, "s1"), "b"), "x".repeat(1000));
    await a.afterTurn("s1", false);
    expect(events.map((e) => [e.unit, e.state, e.bytes, e.sessionIds])).toEqual([["hm", "over", 1500, ["s1"]]]);
    const stored = (await latestManifest(store, hmUnitId("s1")))!.id;

    await a.beforeTurn("s1", "default");
    writeFileSync(join(homeOf(m, "s1"), "c"), "x".repeat(1000));
    const errors = counter("slaude_storage_flush_total", { result: "error" });
    await a.afterTurn("s1", false);
    expect(events[1]).toMatchObject({ unit: "hm", state: "refused", bytes: 2500 });
    expect((await latestManifest(store, hmUnitId("s1")))!.id).toBe(stored);
    expect(await redis.get(`test:fsflush:${hmUnitId("s1")}`)).toBeNull(); // no retry: it cannot help
    expect(counter("slaude_storage_flush_total", { result: "error" })).toBe(errors);
    expect(existsSync(join(homeOf(m, "s1"), "c"))).toBe(true);

    // Space is freed: the next flush goes through.
    await a.beforeTurn("s1", "default");
    rmSync(join(homeOf(m, "s1"), "b"));
    await a.afterTurn("s1", false);
    expect((await latestManifest(store, hmUnitId("s1")))!.id).not.toBe(stored);
    a.stop();
  });

  test("a hydrate that fails on the home drops the session, clears its markers, and parks it again if it was parked", async () => {
    const flaky = new FlakyStore(new LocalObjectStore(tmp("store")));
    const redis = memRedis();
    const m = boxMachine();
    const a = boxNode({ id: "node-a", store: flaky, redis, m });
    await a.beforeTurn("s1", "default");
    writeInstalls(m, "s1", "tool");
    await a.afterTurn("s1", false);
    await a.evict("s1");
    expect(a.parked()).toEqual(["s1"]);

    flaky.failNextList = `sessions/${hmUnitId("s1")}/`;
    await expect(a.beforeTurn("s1", "default")).rejects.toThrow("list unavailable");
    expect(a.tracked()).toEqual([]);
    expect(a.parked()).toEqual(["s1"]); // the copies are still on this disk and still accounted for
    expect(existsSync(join(m.state, `${hmUnitId("s1")}.json`))).toBe(false);
    expect(await a.beforeTurn("s1", "default")).toBe("ok");
    expect(existsSync(join(homeOf(m, "s1"), ".npm-global", "bin", "tool"))).toBe(true);
    a.stop();
  });

  test("drain flushes several boxed sessions at a time, and each one's units in order", async () => {
    const inner = new LocalObjectStore(tmp("store"));
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    const slow: ObjectStore = {
      get: (k, o) => inner.get(k, o),
      head: (k) => inner.head(k),
      list: (p, o) => inner.list(p, o),
      delete: (k) => inner.delete(k),
      put: async (k, b) => {
        if (k.includes("/manifest/")) {
          order.push(k.split("/")[1]!);
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await Bun.sleep(25);
          inFlight--;
        }
        return inner.put(k, b);
      },
    };
    const redis = memRedis();
    const m = boxMachine();
    const cwdOf = (sid: string) => join(m.root, "workspaces", sid);
    const a = boxNode({ id: "node-a", store: slow, redis, m, flush: "idle", cwdOf });
    const sessions = ["s1", "s2", "s3", "s4"];
    for (const sid of sessions) {
      await a.beforeTurn(sid, "default");
      writeFileSync(join(cwdOf(sid), "f.txt"), sid);
      mkdirSync(join(cwdOf(sid), "node_modules"), { recursive: true });
      writeFileSync(join(homeOf(m, sid), "h"), sid);
      await a.afterTurn(sid, false); // idle cadence: only the transcript flushed
    }
    order.length = 0;
    maxInFlight = 0;
    await a.drain();
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    for (const sid of sessions) {
      expect(await latestManifest(inner, hmUnitId(sid))).not.toBeNull();
      const mine = [wsUnitId(cwdOf(sid)), wxUnitId(cwdOf(sid), D1), hmUnitId(sid)];
      expect(order.filter((u) => mine.includes(u))).toEqual(mine); // ws, wx, hm (the transcript had nothing new)
    }
  });
});
