import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { paths } from "../../src/config/home";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsSync, encodeProjectDir, type RedisLike } from "../../src/node/fs-sync";
import { metrics } from "../../src/metrics";
import { makeKeys } from "../../src/queue/keys";
import { LocalObjectStore, latestManifest, wsUnitId, type ObjectInfo, type ObjectStore, type PutBody } from "../../src/storage";

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
