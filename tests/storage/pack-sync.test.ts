import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FencedError,
  LocalObjectStore,
  PACK_MAX_LAYERS,
  PackQuotaError,
  StorageError,
  blobKey,
  flushPack,
  flushTree,
  gcSession,
  hmUnitId,
  hydratePack,
  hydrateTree,
  isPackManifest,
  latestManifest,
  listAll,
  listManifestKeys,
  needsCompaction,
  parseManifest,
  putText,
  manifestKey,
  wsUnitId,
  wxUnitId,
  type AppliedLayer,
  type ObjectStore,
  type PackFn,
  type PackManifest,
} from "../../src/storage";

const tmps: string[] = [];
const tmp = (n: string): string => {
  const d = mkdtempSync(join(tmpdir(), `slaude-pack-${n}-`));
  tmps.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

const yes = () => true;
const uid = () => `hm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const sha = (s: string): string => new Bun.CryptoHasher("sha256").update(s).digest("hex");

/**
 * A stand-in for the box supervisor's packer: the "tree" is a map of path to text, an
 * archive is a JSON file of the changed entries, and the index is the tree as it stood
 * at the manifest id it was recorded for.
 */
function fakeNode(name: string) {
  const base = tmp(name);
  const spool = join(base, "spool");
  mkdirSync(spool, { recursive: true });
  const self = {
    tree: new Map<string, string>(),
    index: null as { base: string; tree: Map<string, string> } | null,
    marker: join(base, "state", "marker.json"),
    spool,
    packs: 0,
    disposed: 0,
    lastCompact: false,
    pack: (async (req) => {
      self.lastCompact = req.compact;
      const live = [...self.tree.values()].reduce((n, v) => n + v.length, 0);
      if (req.maxLiveBytes !== undefined && live > req.maxLiveBytes) throw new PackQuotaError(live, req.maxLiveBytes);
      const usable = self.index !== null && self.index.base === req.base;
      const prev = usable ? self.index!.tree : new Map<string, string>();
      const changed = [...self.tree].filter(([k, v]) => prev.get(k) !== v);
      const removed = [...prev.keys()].filter((k) => !self.tree.has(k));
      if (usable && changed.length === 0 && removed.length === 0) return null;
      const full = !usable || req.compact;
      const entries = full ? [...self.tree] : changed;
      const text = JSON.stringify(entries);
      const path = join(spool, `out-${++self.packs}.pack`);
      writeFileSync(path, text);
      const snapshot = new Map(self.tree);
      return {
        path,
        hash: sha(text),
        bytes: text.length,
        entries: entries.length,
        removed: full ? [] : removed,
        rawBytes: entries.reduce((n, [, v]) => n + v.length, 0),
        full,
        liveBytes: live,
        commit: (id: string) => {
          self.index = { base: id, tree: snapshot };
        },
        dispose: () => {
          self.disposed++;
          rmSync(path, { force: true });
        },
      };
    }) as PackFn,
    apply: async (req: { id: string; layers: AppliedLayer[] }) => {
      const t = new Map<string, string>();
      for (const l of req.layers) {
        for (const r of l.removed) t.delete(r);
        for (const [k, v] of JSON.parse(readFileSync(l.path, "utf8")) as [string, string][]) t.set(k, v);
      }
      self.tree = t;
      self.index = { base: req.id, tree: new Map(t) };
    },
  };
  return self;
}

const pm = async (store: ObjectStore, unit: string): Promise<PackManifest> => (await latestManifest(store, unit))!.manifest as PackManifest;

describe("pack sync", () => {
  test("unit ids: a home is keyed by session, workspace extras by directory and image", () => {
    expect(hmUnitId("abc-123")).toBe("hm-abc-123");
    expect(hmUnitId("a/b")).toMatch(/^hm-[0-9a-f]{32}$/);
    expect(hmUnitId("..")).toMatch(/^hm-[0-9a-f]{32}$/);
    const d1 = `sha256:${"a".repeat(64)}`;
    const d2 = `sha256:${"b".repeat(64)}`;
    expect(wxUnitId("/w/one", d1)).toBe(`${wsUnitId("/w/one").replace(/^ws-/, "wx-")}-${"a".repeat(12)}`);
    expect(wxUnitId("/w/one", d1)).not.toBe(wxUnitId("/w/one", d2));
    expect(wxUnitId("/w/one", d1)).not.toBe(wxUnitId("/w/two", d1));
    expect(() => wxUnitId("/w/one", "latest")).toThrow();
  });

  test("the first flush writes one full layer; hydrate on another node reproduces the tree", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const unit = uid();
    const a = fakeNode("a");
    a.tree.set(".npmrc", "prefix=~/.npm-global");
    a.tree.set(".npm-global/bin/tool", "#!/bin/sh");
    const f = await flushPack(store, unit, { epoch: 1, isCurrent: yes, pack: a.pack });
    expect(f.changed).toBe(true);
    expect(f.full).toBe(true);
    expect(f.uploadedBlobs).toBe(1);
    const m = await pm(store, unit);
    expect(isPackManifest(m)).toBe(true);
    expect(m.version).toBe(2);
    expect(m.kind).toBe("pack");
    expect(m.layers.length).toBe(1);
    expect(m.layers[0]!.entries).toBe(2);
    expect(await store.head(blobKey(unit, m.layers[0]!.hash))).not.toBeNull();
    expect(readdirSync(a.spool)).toEqual([]);

    const b = fakeNode("b");
    const h = await hydratePack(store, unit, { markerPath: b.marker, spoolDir: b.spool, apply: b.apply });
    expect(h.mode).toBe("cold");
    expect(h.id).toBe(f.id);
    expect(h.downloadedBytes).toBe(m.layers[0]!.bytes);
    expect([...b.tree]).toEqual([...a.tree]);
    expect(readdirSync(b.spool)).toEqual([]);
  });

  test("a flush of an unchanged tree builds nothing and writes nothing", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const unit = uid();
    const a = fakeNode("a");
    a.tree.set("f", "1");
    const first = await flushPack(store, unit, { epoch: 1, isCurrent: yes, pack: a.pack });
    const before = (await listAll(store, `sessions/${unit}/`)).map((o) => o.key);
    const again = await flushPack(store, unit, { epoch: 1, isCurrent: yes, pack: a.pack });
    expect(again.changed).toBe(false);
    expect(again.id).toBe(first.id);
    expect(again.uploadedBlobs).toBe(0);
    expect((await listAll(store, `sessions/${unit}/`)).map((o) => o.key)).toEqual(before);
    expect(a.packs).toBe(1);
  });

  test("a later flush appends a delta layer with the removed paths", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const unit = uid();
    const a = fakeNode("a");
    a.tree.set("keep", "k");
    a.tree.set("gone", "g");
    await flushPack(store, unit, { epoch: 1, isCurrent: yes, pack: a.pack });
    a.tree.delete("gone");
    a.tree.set("new", "n");
    const f = await flushPack(store, unit, { epoch: 1, isCurrent: yes, pack: a.pack });
    expect(f.full).toBe(false);
    const m = await pm(store, unit);
    expect(m.seq).toBe(2);
    expect(m.layers.length).toBe(2);
    expect(m.layers[1]!.entries).toBe(1);
    expect(m.layers[1]!.removed).toEqual(["gone"]);

    const b = fakeNode("b");
    await hydratePack(store, unit, { markerPath: b.marker, spoolDir: b.spool, apply: b.apply });
    expect([...b.tree].sort()).toEqual([
      ["keep", "k"],
      ["new", "n"],
    ]);
  });

  test("more than the layer limit: the next flush writes one full layer, and gc then drops the old archives", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const unit = uid();
    const a = fakeNode("a");
    a.tree.set("big", "x".repeat(10_000)); // large against the churn, so only the layer count can fire the rule
    for (let i = 0; i <= PACK_MAX_LAYERS; i++) {
      a.tree.set(`f${i}`, String(i));
      await flushPack(store, unit, { epoch: 1, isCurrent: yes, pack: a.pack });
    }
    expect((await pm(store, unit)).layers.length).toBe(PACK_MAX_LAYERS + 1);
    const old = (await pm(store, unit)).layers.map((l) => l.hash);

    // Nothing changed: the rule waits. Compaction never writes on its own.
    expect((await flushPack(store, unit, { epoch: 1, isCurrent: yes, pack: a.pack })).changed).toBe(false);

    a.tree.set("last", "z");
    const f = await flushPack(store, unit, { epoch: 1, isCurrent: yes, pack: a.pack });
    expect(a.lastCompact).toBe(true);
    expect(f.full).toBe(true);
    const m = await pm(store, unit);
    expect(m.layers.length).toBe(1);
    expect(m.layers[0]!.removed).toEqual([]);

    const b = fakeNode("b");
    await hydratePack(store, unit, { markerPath: b.marker, spoolDir: b.spool, apply: b.apply });
    expect([...b.tree].sort()).toEqual([...a.tree].sort());

    // gc with one manifest kept: only the full layer is live. The grace window is closed by a late clock.
    const r = await gcSession(store, unit, { keep: 1, graceMs: 1000, now: Date.now() + 60_000 });
    expect(r.manifestsDeleted).toBe(PACK_MAX_LAYERS + 1);
    expect(r.blobsDeleted).toBe(old.length);
    for (const h of old) expect(await store.head(blobKey(unit, h))).toBeNull();
    expect(await store.head(blobKey(unit, m.layers[0]!.hash))).not.toBeNull();
  });

  test("gc keeps every layer a retained manifest names", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const unit = uid();
    const a = fakeNode("a");
    for (let i = 0; i < 4; i++) {
      a.tree.set(`f${i}`, String(i));
      await flushPack(store, unit, { epoch: 1, isCurrent: yes, pack: a.pack });
    }
    const m = await pm(store, unit);
    expect(m.layers.length).toBe(4);
    const r = await gcSession(store, unit, { keep: 1, graceMs: 1000, now: Date.now() + 60_000 });
    expect(r.manifestsDeleted).toBe(3);
    expect(r.blobsDeleted).toBe(0);
    for (const l of m.layers) expect(await store.head(blobKey(unit, l.hash))).not.toBeNull();
    const b = fakeNode("b");
    await hydratePack(store, unit, { markerPath: b.marker, spoolDir: b.spool, apply: b.apply });
    expect(b.tree.size).toBe(4);
  });

  test("layers holding more than 1.5 times the live bytes trigger compaction", () => {
    const l = (rawBytes: number) => ({ hash: "a".repeat(64), bytes: 1, entries: 1, removed: [], rawBytes });
    expect(needsCompaction({ layers: [l(100)], liveBytes: 10 })).toBe(false); // one layer is already compact
    expect(needsCompaction({ layers: [l(100), l(40)], liveBytes: 100 })).toBe(false);
    expect(needsCompaction({ layers: [l(100), l(60)], liveBytes: 100 })).toBe(true);
    expect(needsCompaction({ layers: [l(100), l(60)] })).toBe(false); // no live size recorded: the count decides
    expect(needsCompaction({ layers: Array.from({ length: PACK_MAX_LAYERS + 1 }, () => l(1)), liveBytes: 1_000_000 })).toBe(true);
    expect(needsCompaction({ layers: Array.from({ length: PACK_MAX_LAYERS }, () => l(1)), liveBytes: 1_000_000 })).toBe(false);
  });

  test("a fenced flush writes no manifest and never records the index", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const unit = uid();
    const a = fakeNode("a");
    a.tree.set("f", "1");
    const first = await flushPack(store, unit, { epoch: 1, isCurrent: yes, pack: a.pack });
    a.tree.set("f", "2");
    const keys = await listManifestKeys(store, unit);
    await expect(flushPack(store, unit, { epoch: 1, isCurrent: () => false, pack: a.pack })).rejects.toBeInstanceOf(FencedError);
    expect(await listManifestKeys(store, unit)).toEqual(keys);
    expect((await latestManifest(store, unit))!.id).toBe(first.id);
    expect(a.index!.base).toBe(first.id);
    expect(a.index!.tree.get("f")).toBe("1");
    expect(readdirSync(a.spool)).toEqual([]);
    expect(a.disposed).toBe(2);
  });

  test("a flush with an epoch below the stored one is fenced before anything is packed", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const unit = uid();
    const a = fakeNode("a");
    a.tree.set("f", "1");
    await flushPack(store, unit, { epoch: 5, isCurrent: yes, pack: a.pack });
    const z = fakeNode("zombie");
    z.tree.set("f", "old");
    await expect(flushPack(store, unit, { epoch: 4, isCurrent: yes, pack: z.pack })).rejects.toBeInstanceOf(FencedError);
    expect(z.packs).toBe(0);
  });

  test("a new epoch restarts the sequence and wins over the old one", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const unit = uid();
    const a = fakeNode("a");
    a.tree.set("f", "1");
    await flushPack(store, unit, { epoch: 1, isCurrent: yes, pack: a.pack });
    a.tree.set("f", "2");
    const f = await flushPack(store, unit, { epoch: 2, isCurrent: yes, pack: a.pack });
    const m = await pm(store, unit);
    expect([m.epoch, m.seq]).toEqual([2, 1]);
    expect(m.layers.length).toBe(2);
    expect((await latestManifest(store, unit))!.id).toBe(f.id);
  });

  test("a packer with no index for the stored manifest writes a full layer that replaces the others", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const unit = uid();
    const a = fakeNode("a");
    a.tree.set("f", "1");
    await flushPack(store, unit, { epoch: 1, isCurrent: yes, pack: a.pack });
    a.tree.set("g", "2");
    await flushPack(store, unit, { epoch: 1, isCurrent: yes, pack: a.pack });
    a.index = null; // the index file was lost
    a.tree.set("h", "3");
    const f = await flushPack(store, unit, { epoch: 1, isCurrent: yes, pack: a.pack });
    expect(f.full).toBe(true);
    expect((await pm(store, unit)).layers.length).toBe(1);
  });

  test("hydrate is warm when the marker names the latest manifest, and empty before the first flush", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const unit = uid();
    const b = fakeNode("b");
    let applies = 0;
    const apply = async (req: { id: string; layers: AppliedLayer[] }) => {
      applies++;
      await b.apply(req);
    };
    expect((await hydratePack(store, unit, { markerPath: b.marker, spoolDir: b.spool, apply })).mode).toBe("empty");
    expect(applies).toBe(0);

    const a = fakeNode("a");
    a.tree.set("f", "1");
    await flushPack(store, unit, { epoch: 1, isCurrent: yes, pack: a.pack });
    expect((await hydratePack(store, unit, { markerPath: b.marker, spoolDir: b.spool, apply })).mode).toBe("cold");
    const warm = await hydratePack(store, unit, { markerPath: b.marker, spoolDir: b.spool, apply });
    expect(warm.mode).toBe("warm");
    expect(warm.downloadedBytes).toBe(0);
    expect(applies).toBe(1);

    // Another node moved the unit on: the marker is stale, so the copy is replaced.
    a.tree.set("f", "2");
    await flushPack(store, unit, { epoch: 2, isCurrent: yes, pack: a.pack });
    expect((await hydratePack(store, unit, { markerPath: b.marker, spoolDir: b.spool, apply })).mode).toBe("cold");
    expect(b.tree.get("f")).toBe("2");
  });

  test("a missing layer fails the hydrate, applies nothing and leaves no marker", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const unit = uid();
    const a = fakeNode("a");
    a.tree.set("f", "1");
    await flushPack(store, unit, { epoch: 1, isCurrent: yes, pack: a.pack });
    a.tree.set("g", "2");
    await flushPack(store, unit, { epoch: 1, isCurrent: yes, pack: a.pack });
    const b = fakeNode("b");
    await hydratePack(store, unit, { markerPath: b.marker, spoolDir: b.spool, apply: b.apply });
    a.tree.set("h", "3");
    await flushPack(store, unit, { epoch: 1, isCurrent: yes, pack: a.pack });
    const m = await pm(store, unit);
    await store.delete([blobKey(unit, m.layers[1]!.hash)]);

    let applied = false;
    const err = await hydratePack(store, unit, {
      markerPath: b.marker,
      spoolDir: b.spool,
      apply: async () => {
        applied = true;
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect(String(err.message)).toContain("missing from the store");
    expect(applied).toBe(false);
    expect(existsSync(b.marker)).toBe(false);
    expect(readdirSync(b.spool)).toEqual([]);
  });

  test("a layer whose bytes do not match its hash is refused before the packer sees it", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const unit = uid();
    const a = fakeNode("a");
    a.tree.set("f", "1");
    await flushPack(store, unit, { epoch: 1, isCurrent: yes, pack: a.pack });
    const m = await pm(store, unit);
    const evil = "y".repeat(m.layers[0]!.bytes); // same size, other bytes
    await store.put(blobKey(unit, m.layers[0]!.hash), new TextEncoder().encode(evil));
    const b = fakeNode("b");
    let applied = false;
    await expect(
      hydratePack(store, unit, {
        markerPath: b.marker,
        spoolDir: b.spool,
        apply: async () => {
          applied = true;
        },
      }),
    ).rejects.toThrow(/does not match its hash/);
    expect(applied).toBe(false);
    expect(readdirSync(b.spool)).toEqual([]);
  });

  test("a tree over the ceiling is refused: nothing is uploaded, nothing is written", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const unit = uid();
    const a = fakeNode("a");
    a.tree.set("f", "x".repeat(100));
    await expect(flushPack(store, unit, { epoch: 1, isCurrent: yes, pack: a.pack, maxLiveBytes: 50 })).rejects.toBeInstanceOf(PackQuotaError);
    expect(await listAll(store, `sessions/${unit}/`)).toEqual([]);
    expect((await flushPack(store, unit, { epoch: 1, isCurrent: yes, pack: a.pack, maxLiveBytes: 500 })).changed).toBe(true);
  });

  test("the two formats never share a unit", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const dir = tmp("tree");
    writeFileSync(join(dir, "a.txt"), "a");
    const treeUnit = uid();
    await flushTree(store, treeUnit, [{ name: "ws", dir }], { epoch: 1, isCurrent: yes });
    const a = fakeNode("a");
    a.tree.set("f", "1");
    await expect(flushPack(store, treeUnit, { epoch: 2, isCurrent: yes, pack: a.pack })).rejects.toThrow(/per-file manifest/);
    await expect(hydratePack(store, treeUnit, { markerPath: a.marker, spoolDir: a.spool, apply: a.apply })).rejects.toThrow(/per-file manifest/);
    expect(a.packs).toBe(0);

    const packUnit = uid();
    await flushPack(store, packUnit, { epoch: 1, isCurrent: yes, pack: a.pack });
    await expect(flushTree(store, packUnit, [{ name: "ws", dir }], { epoch: 2, isCurrent: yes })).rejects.toThrow(/pack manifest/);
    await expect(hydrateTree(store, packUnit, [{ name: "ws", dir }], { markerPath: join(tmp("m"), "m.json") })).rejects.toThrow(/pack manifest/);
  });

  test("a stored pack manifest with a bad layer is refused at read", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const unit = uid();
    const bad = (layers: unknown) => JSON.stringify({ version: 2, kind: "pack", sessionId: unit, epoch: 1, seq: 1, createdAt: 0, layers });
    expect(() => parseManifest(bad([{ hash: "../../x", bytes: 1, entries: 1, removed: [] }]))).toThrow(StorageError);
    expect(() => parseManifest(bad([{ hash: "a".repeat(64), bytes: -1, entries: 1, removed: [] }]))).toThrow(StorageError);
    expect(() => parseManifest(bad([{ hash: "a".repeat(64), bytes: 1, entries: 1, removed: [1] }]))).toThrow(StorageError);
    expect(() => parseManifest(bad("nope"))).toThrow(StorageError);
    expect(() => parseManifest(JSON.stringify({ version: 2, kind: "other", layers: [] }))).toThrow(StorageError);

    await putText(store, manifestKey(unit, 1, 1), bad([{ hash: "a".repeat(64), bytes: 1, entries: 1, removed: ["../escape"] }]));
    const b = fakeNode("b");
    let applied = false;
    await expect(
      hydratePack(store, unit, {
        markerPath: b.marker,
        spoolDir: b.spool,
        apply: async () => {
          applied = true;
        },
      }),
    ).rejects.toThrow(/unsafe removed path/);
    expect(applied).toBe(false);
  });

  test("a packer that returns an unsafe removed path or a delta with nothing stored is refused", async () => {
    const store = new LocalObjectStore(tmp("store"));
    const a = fakeNode("a");
    a.tree.set("f", "1");
    const wrap =
      (patch: Record<string, unknown>): PackFn =>
      async (req) => ({ ...(await a.pack(req))!, ...patch });
    await expect(flushPack(store, uid(), { epoch: 1, isCurrent: yes, pack: wrap({ full: false, removed: ["/etc/passwd"] }) })).rejects.toThrow(/unsafe removed path/);
    await expect(flushPack(store, uid(), { epoch: 1, isCurrent: yes, pack: wrap({ full: false }) })).rejects.toThrow(/nothing stored/);
    await expect(flushPack(store, uid(), { epoch: 1, isCurrent: yes, pack: async () => null })).rejects.toThrow(/nothing stored/);
    expect(readdirSync(a.spool)).toEqual([]);
  });
});
