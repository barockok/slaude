import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsSync, encodeProjectDir, type RedisLike } from "../../src/node/fs-sync";
import { metrics } from "../../src/metrics";
import { makeKeys } from "../../src/queue/keys";
import { LocalObjectStore, latestManifest, type ObjectStore, type PutBody } from "../../src/storage";

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
function memRedis(): RedisLike {
  const m = new Map<string, string>();
  return {
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
  list(prefix: string, opts?: { after?: string; limit?: number }) {
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

const txFile = (m: Machine) => join(m.claude, "projects", encodeProjectDir(m.cwd), "sdk-session.jsonl");

/** Wipe a machine's disk: the session lands on a different node. */
function wipe(m: Machine): void {
  rmSync(m.cwd, { recursive: true, force: true });
  rmSync(m.claude, { recursive: true, force: true });
  rmSync(m.state, { recursive: true, force: true });
}

beforeEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
});

describe("FsSync", () => {
  test("encodeProjectDir matches the SDK's directory naming", () => {
    expect(encodeProjectDir("/Users/a/Code/slaude")).toBe("-Users-a-Code-slaude");
    expect(encodeProjectDir("/data/workspaces/T1-C1-1700000000.000100")).toBe("-data-workspaces-T1-C1-1700000000-000100");
  });

  test("a turn on node A is visible, with its transcript, on node B", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const redis = memRedis();
    const m = machine();
    const a = nodeSync({ id: "node-a", store, redis, m });
    expect(await a.beforeTurn("s1", "default")).toBe("ok");
    writeFileSync(join(m.cwd, "notes.md"), "made on A");
    mkdirSync(join(m.claude, "projects", encodeProjectDir(m.cwd)), { recursive: true });
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
    mkdirSync(join(m.claude, "projects", encodeProjectDir(m.cwd)), { recursive: true });
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

  test("eviction keeps the folder while another session on the node still works in it", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const redis = memRedis();
    const m = machine();
    const a = nodeSync({ id: "node-a", store, redis, m });
    await a.beforeTurn("s1", "default");
    await a.beforeTurn("s2", "default"); // a second session in the same folder
    writeFileSync(join(m.cwd, "shared.txt"), "shared");
    await a.afterTurn("s2", false);
    await a.evict("s1");
    expect(existsSync(join(m.cwd, "shared.txt"))).toBe(true);
    await a.evict("s2");
    expect(existsSync(m.cwd)).toBe(false);
  });
});
