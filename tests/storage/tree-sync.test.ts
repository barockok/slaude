import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FencedError,
  LocalObjectStore,
  RootMissingError,
  S3ObjectStore,
  drainInbox,
  flushTree,
  gcSession,
  hydrateTree,
  latestManifest,
  listAll,
  manifestKey,
  putInbox,
  removeUnit,
  wsUnitId,
  type ObjectStore,
  type Root,
} from "../../src/storage";

const tmps: string[] = [];
const tmp = (n: string): string => {
  const d = mkdtempSync(join(tmpdir(), `slaude-sync-${n}-`));
  tmps.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

const yes = () => true;
const sid = () => `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** A "node": its own roots and marker, so two of them model two machines. */
function node(name: string) {
  const base = tmp(name);
  const roots: Root[] = [
    { name: "ws", dir: join(base, "ws") },
    { name: "tx", dir: join(base, "tx") },
  ];
  // As on a node, where hydrate creates every root before a turn: a flush refuses a missing one.
  for (const r of roots) mkdirSync(r.dir, { recursive: true });
  return { roots, marker: join(base, "state", "marker.json"), ws: roots[0]!.dir, tx: roots[1]!.dir };
}

function suite(name: string, makeStore: () => ObjectStore) {
  describe(`tree sync: ${name}`, () => {
    test("flush on one node, hydrate on another reproduces the tree", async () => {
      const store = makeStore();
      const id = sid();
      const a = node("a");
      mkdirSync(join(a.ws, "src", "deep"), { recursive: true });
      mkdirSync(join(a.ws, "empty-dir"), { recursive: true });
      writeFileSync(join(a.ws, "README.md"), "hello\n");
      writeFileSync(join(a.ws, "src", "deep", "x.ts"), "export const x = 1;\n");
      writeFileSync(join(a.ws, "run.sh"), "#!/bin/sh\necho hi\n");
      chmodSync(join(a.ws, "run.sh"), 0o755);
      mkdirSync(a.tx, { recursive: true });
      writeFileSync(join(a.tx, "s.jsonl"), '{"a":1}\n');
      symlinkSync("README.md", join(a.ws, "link-to-readme"));

      const f = await flushTree(store, id, a.roots, { epoch: 1, isCurrent: yes });
      expect(f.changed).toBe(true);
      expect(f.uploadedBlobs).toBeGreaterThan(0);

      const b = node("b");
      const h = await hydrateTree(store, id, b.roots, { markerPath: b.marker });
      expect(h.mode).toBe("cold");
      expect(h.id).toBe(f.id);
      expect(readFileSync(join(b.ws, "README.md"), "utf8")).toBe("hello\n");
      expect(readFileSync(join(b.ws, "src", "deep", "x.ts"), "utf8")).toBe("export const x = 1;\n");
      expect(existsSync(join(b.ws, "empty-dir"))).toBe(true);
      expect(lstatSync(join(b.ws, "run.sh")).mode & 0o777).toBe(0o755);
      expect(readFileSync(join(b.tx, "s.jsonl"), "utf8")).toBe('{"a":1}\n');
      expect(readlinkSync(join(b.ws, "link-to-readme"))).toBe("README.md");
    });

    test("a second flush of an unchanged tree uploads and writes nothing", async () => {
      const store = makeStore();
      const id = sid();
      const a = node("a");
      mkdirSync(a.ws, { recursive: true });
      writeFileSync(join(a.ws, "f.txt"), "one");
      const first = await flushTree(store, id, a.roots, { epoch: 1, isCurrent: yes });
      const second = await flushTree(store, id, a.roots, { epoch: 1, isCurrent: yes });
      expect(second.changed).toBe(false);
      expect(second.uploadedBlobs).toBe(0);
      expect(second.id).toBe(first.id);
    });

    test("an incremental flush uploads only the changed file", async () => {
      const store = makeStore();
      const id = sid();
      const a = node("a");
      mkdirSync(a.ws, { recursive: true });
      writeFileSync(join(a.ws, "keep.txt"), "keep");
      writeFileSync(join(a.ws, "edit.txt"), "v1");
      await flushTree(store, id, a.roots, { epoch: 1, isCurrent: yes });
      writeFileSync(join(a.ws, "edit.txt"), "v2-longer");
      const f = await flushTree(store, id, a.roots, { epoch: 1, isCurrent: yes });
      expect(f.changed).toBe(true);
      expect(f.uploadedBlobs).toBe(1);
      const latest = await latestManifest(store, id);
      expect(latest?.manifest.seq).toBe(2);
    });

    test("hydrate is warm when the marker already names the latest manifest", async () => {
      const store = makeStore();
      const id = sid();
      const a = node("a");
      mkdirSync(a.ws, { recursive: true });
      writeFileSync(join(a.ws, "f.txt"), "x");
      await flushTree(store, id, a.roots, { epoch: 1, isCurrent: yes });
      const b = node("b");
      expect((await hydrateTree(store, id, b.roots, { markerPath: b.marker })).mode).toBe("cold");
      const again = await hydrateTree(store, id, b.roots, { markerPath: b.marker });
      expect(again.mode).toBe("warm");
      expect(again.downloadedBytes).toBe(0);
    });

    test("hydrate over an older copy fetches only what changed and removes what is gone", async () => {
      const store = makeStore();
      const id = sid();
      const a = node("a");
      mkdirSync(a.ws, { recursive: true });
      writeFileSync(join(a.ws, "stay.txt"), "stay");
      writeFileSync(join(a.ws, "gone.txt"), "gone");
      await flushTree(store, id, a.roots, { epoch: 1, isCurrent: yes });
      const b = node("b");
      await hydrateTree(store, id, b.roots, { markerPath: b.marker });
      rmSync(join(a.ws, "gone.txt"));
      writeFileSync(join(a.ws, "new.txt"), "brand new");
      await flushTree(store, id, a.roots, { epoch: 2, isCurrent: yes });
      const h = await hydrateTree(store, id, b.roots, { markerPath: b.marker });
      expect(h.mode).toBe("cold");
      expect(h.downloadedBytes).toBe("brand new".length);
      expect(existsSync(join(b.ws, "gone.txt"))).toBe(false);
      expect(readFileSync(join(b.ws, "new.txt"), "utf8")).toBe("brand new");
      expect(readFileSync(join(b.ws, "stay.txt"), "utf8")).toBe("stay");
    });

    test("a stale epoch cannot commit, and readers take the highest epoch", async () => {
      const store = makeStore();
      const id = sid();
      const newer = node("newer");
      mkdirSync(newer.ws, { recursive: true });
      writeFileSync(join(newer.ws, "f.txt"), "from epoch 2");
      await flushTree(store, id, newer.roots, { epoch: 2, isCurrent: yes });

      const zombie = node("zombie");
      mkdirSync(zombie.ws, { recursive: true });
      writeFileSync(join(zombie.ws, "f.txt"), "from epoch 1");
      await expect(flushTree(store, id, zombie.roots, { epoch: 1, isCurrent: yes })).rejects.toBeInstanceOf(FencedError);

      const reader = node("reader");
      await hydrateTree(store, id, reader.roots, { markerPath: reader.marker });
      expect(readFileSync(join(reader.ws, "f.txt"), "utf8")).toBe("from epoch 2");
    });

    test("a late manifest from a lower epoch is ignored by readers", async () => {
      const store = makeStore();
      const id = sid();
      const a = node("a");
      mkdirSync(a.ws, { recursive: true });
      writeFileSync(join(a.ws, "f.txt"), "good");
      const good = await flushTree(store, id, a.roots, { epoch: 5, isCurrent: yes });
      // A zombie's manifest lands after the fact, under its lower epoch.
      await store.put(manifestKey(id, 4, 9), new TextEncoder().encode(JSON.stringify({ version: 1, sessionId: id, epoch: 4, seq: 9, createdAt: 0, dirs: [], files: {} })));
      expect((await latestManifest(store, id))?.id).toBe(good.id);
    });

    test("isCurrent turning false before the commit fences the flush and leaves no manifest", async () => {
      const store = makeStore();
      const id = sid();
      const a = node("a");
      mkdirSync(a.ws, { recursive: true });
      writeFileSync(join(a.ws, "f.txt"), "x");
      await expect(flushTree(store, id, a.roots, { epoch: 1, isCurrent: () => false })).rejects.toBeInstanceOf(FencedError);
      expect(await latestManifest(store, id)).toBeNull();
    });

    test("ignored paths never sync", async () => {
      const store = makeStore();
      const id = sid();
      const a = node("a");
      mkdirSync(join(a.ws, "node_modules", "pkg"), { recursive: true });
      writeFileSync(join(a.ws, "node_modules", "pkg", "i.js"), "x");
      writeFileSync(join(a.ws, "real.txt"), "r");
      await flushTree(store, id, a.roots, { epoch: 1, isCurrent: yes });
      const keys = Object.keys((await latestManifest(store, id))!.manifest.files);
      expect(keys).toEqual(["ws/real.txt"]);
    });

    test("a manifest naming a path outside the root is refused on hydrate", async () => {
      const store = makeStore();
      const id = sid();
      const evil = { version: 1, sessionId: id, epoch: 1, seq: 1, createdAt: 0, dirs: [], files: { "ws/../../escape.txt": { type: "file", hash: "0".repeat(64), size: 1, mode: 0o644, mtimeMs: 1 } } };
      await store.put(manifestKey(id, 1, 1), new TextEncoder().encode(JSON.stringify(evil)));
      const b = node("b");
      await expect(hydrateTree(store, id, b.roots, { markerPath: b.marker })).rejects.toThrow(/unsafe path/);
    });

    test("hydrate never writes through a symlinked directory: the link is replaced and its target is untouched", async () => {
      const store = makeStore();
      const id = sid();
      const a = node("a");
      mkdirSync(join(a.ws, "d"), { recursive: true });
      writeFileSync(join(a.ws, "d", "f.txt"), "payload");
      await flushTree(store, id, a.roots, { epoch: 1, isCurrent: yes });
      const b = node("b");
      const outside = tmp("outside");
      writeFileSync(join(outside, "keep.txt"), "not ours");
      mkdirSync(b.ws, { recursive: true });
      symlinkSync(outside, join(b.ws, "d"));
      await hydrateTree(store, id, b.roots, { markerPath: b.marker });
      expect(lstatSync(join(b.ws, "d")).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(b.ws, "d", "f.txt"), "utf8")).toBe("payload");
      expect(existsSync(join(outside, "f.txt"))).toBe(false);
      expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("not ours");
    });

    test("a path that changed from a file to a directory hydrates over the old copy", async () => {
      const store = makeStore();
      const id = sid();
      const a = node("a");
      mkdirSync(a.ws, { recursive: true });
      writeFileSync(join(a.ws, "x"), "was a file");
      await flushTree(store, id, a.roots, { epoch: 1, isCurrent: yes });
      const b = node("b");
      await hydrateTree(store, id, b.roots, { markerPath: b.marker });
      expect(readFileSync(join(b.ws, "x"), "utf8")).toBe("was a file");
      rmSync(join(a.ws, "x"));
      mkdirSync(join(a.ws, "x"));
      writeFileSync(join(a.ws, "x", "y"), "now a directory");
      await flushTree(store, id, a.roots, { epoch: 2, isCurrent: yes });
      await hydrateTree(store, id, b.roots, { markerPath: b.marker });
      expect(readFileSync(join(b.ws, "x", "y"), "utf8")).toBe("now a directory");
    });

    test("a flush refuses a missing root instead of committing an empty tree", async () => {
      const store = makeStore();
      const id = sid();
      const a = node("a");
      mkdirSync(a.ws, { recursive: true });
      writeFileSync(join(a.ws, "precious.txt"), "keep me");
      const first = await flushTree(store, id, a.roots, { epoch: 1, isCurrent: yes });
      rmSync(a.ws, { recursive: true, force: true });
      await expect(flushTree(store, id, a.roots, { epoch: 2, isCurrent: yes })).rejects.toBeInstanceOf(RootMissingError);
      expect((await latestManifest(store, id))?.id).toBe(first.id);
      const b = node("b");
      await hydrateTree(store, id, b.roots, { markerPath: b.marker });
      expect(readFileSync(join(b.ws, "precious.txt"), "utf8")).toBe("keep me");
    });

    test("a hydrate that dies half way leaves no marker, so the next one is a full pass", async () => {
      const store = makeStore();
      const id = sid();
      const a = node("a");
      mkdirSync(a.ws, { recursive: true });
      writeFileSync(join(a.ws, "one.txt"), "1");
      await flushTree(store, id, a.roots, { epoch: 1, isCurrent: yes });
      const b = node("b");
      await hydrateTree(store, id, b.roots, { markerPath: b.marker });
      expect(existsSync(b.marker)).toBe(true);
      writeFileSync(join(a.ws, "two.txt"), "2");
      const f2 = await flushTree(store, id, a.roots, { epoch: 2, isCurrent: yes });
      // Break the new blob so the next hydrate throws part way.
      const m = (await latestManifest(store, id))!.manifest;
      await store.delete([`sessions/${id}/blobs/${(m.files["ws/two.txt"] as { hash: string }).hash}`]);
      await expect(hydrateTree(store, id, b.roots, { markerPath: b.marker })).rejects.toThrow(/missing from the store/);
      expect(existsSync(b.marker)).toBe(false);
      expect(f2.changed).toBe(true);
    });

    test("staged inbox files are written into the directory and removed from the box", async () => {
      const store = makeStore();
      const gw = tmp("gateway");
      mkdirSync(join(gw, "attachments", "1700000000.000100"), { recursive: true });
      const file = join(gw, "attachments", "1700000000.000100", "report.pdf");
      writeFileSync(file, "pdf bytes");
      await putInbox(store, gw, file);
      const nodeDir = tmp("nodews");
      const n = await drainInbox(store, wsUnitId(gw), nodeDir);
      expect(n).toBe(1);
      expect(readFileSync(join(nodeDir, "attachments", "1700000000.000100", "report.pdf"), "utf8")).toBe("pdf bytes");
      expect(await listAll(store, "inbox/")).toEqual([]);
      expect(await drainInbox(store, wsUnitId(gw), nodeDir)).toBe(0);
    });

    test("one staged file that cannot be written does not hold up the others", async () => {
      const store = makeStore();
      const gw = tmp("gateway");
      const nodeDir = tmp("nodews");
      for (const [dir, name] of [["blocked", "stuck.txt"], ["fine", "ok.txt"]] as const) {
        mkdirSync(join(gw, dir), { recursive: true });
        writeFileSync(join(gw, dir, name), name);
        await putInbox(store, gw, join(gw, dir, name));
      }
      // The node may not write into `blocked` (a directory an earlier root process left behind).
      mkdirSync(join(nodeDir, "blocked"));
      chmodSync(join(nodeDir, "blocked"), 0o500);
      try {
        const n = await drainInbox(store, wsUnitId(gw), nodeDir);
        expect(readFileSync(join(nodeDir, "fine", "ok.txt"), "utf8")).toBe("ok.txt");
        if (process.getuid && process.getuid() !== 0) {
          expect(n).toBe(1);
          expect((await listAll(store, "inbox/")).map((o) => o.key.split("/").pop())).toEqual(["stuck.txt"]); // kept for a later turn
        }
      } finally {
        chmodSync(join(nodeDir, "blocked"), 0o700);
      }
    });

    test("an inbox file from outside its working directory is refused", async () => {
      const store = makeStore();
      const gw = tmp("gateway");
      const other = tmp("other");
      writeFileSync(join(other, "x.txt"), "x");
      await expect(putInbox(store, gw, join(other, "x.txt"))).rejects.toThrow(/outside its working directory/);
    });

    test("a large file streams through and comes back identical", async () => {
      const store = makeStore();
      const id = sid();
      const a = node("a");
      mkdirSync(a.ws, { recursive: true });
      const big = Buffer.alloc(24 * 1024 * 1024, 7);
      big.write("header", 0);
      writeFileSync(join(a.ws, "big.bin"), big);
      await flushTree(store, id, a.roots, { epoch: 1, isCurrent: yes });
      const b = node("b");
      await hydrateTree(store, id, b.roots, { markerPath: b.marker });
      expect(Buffer.compare(readFileSync(join(b.ws, "big.bin")), big)).toBe(0);
    }, 60_000);

    test("identical files share one blob", async () => {
      const store = makeStore();
      const id = sid();
      const a = node("a");
      mkdirSync(a.ws, { recursive: true });
      writeFileSync(join(a.ws, "one.txt"), "same");
      writeFileSync(join(a.ws, "two.txt"), "same");
      const f = await flushTree(store, id, a.roots, { epoch: 1, isCurrent: yes });
      expect(f.uploadedBlobs).toBe(1);
    });

    test("gc keeps the newest manifests, deletes unreferenced old blobs, and spares young ones", async () => {
      const store = makeStore();
      const id = sid();
      const a = node("a");
      mkdirSync(a.ws, { recursive: true });
      for (let i = 1; i <= 4; i++) {
        writeFileSync(join(a.ws, "f.txt"), `version ${i}`);
        utimesSync(join(a.ws, "f.txt"), 1000 + i, 1000 + i);
        await flushTree(store, id, a.roots, { epoch: 1, isCurrent: yes });
      }
      const before = (await listAll(store, `sessions/${id}/blobs/`)).length;
      expect(before).toBe(4);
      const young = await gcSession(store, id, { keep: 2 });
      expect(young.manifestsDeleted).toBe(2);
      expect(young.blobsDeleted).toBe(0); // inside the grace window
      const old = await gcSession(store, id, { keep: 2, graceMs: 0, now: Date.now() + 1000 });
      expect(old.blobsDeleted).toBe(2);
      const b = node("b");
      await hydrateTree(store, id, b.roots, { markerPath: b.marker });
      expect(readFileSync(join(b.ws, "f.txt"), "utf8")).toBe("version 4");
    });

    test("removeUnit deletes everything stored for the session", async () => {
      const store = makeStore();
      const id = sid();
      const a = node("a");
      mkdirSync(a.ws, { recursive: true });
      writeFileSync(join(a.ws, "f.txt"), "x");
      await flushTree(store, id, a.roots, { epoch: 1, isCurrent: yes });
      expect(await removeUnit(store, id)).toBeGreaterThan(0);
      expect(await listAll(store, `sessions/${id}/`)).toEqual([]);
    });
  });
}

suite("LocalObjectStore", () => new LocalObjectStore(tmp("store")));

const endpoint = process.env.SLAUDE_S3_TEST_ENDPOINT;
if (endpoint) {
  const cfg = {
    endpoint,
    region: "us-east-1",
    bucket: process.env.SLAUDE_S3_TEST_BUCKET ?? "slaude-test",
    prefix: `tree-${Date.now()}`,
    pathStyle: true,
    accessKeyId: process.env.SLAUDE_S3_TEST_ACCESS_KEY_ID ?? "slaude-test",
    secretAccessKey: process.env.SLAUDE_S3_TEST_SECRET_ACCESS_KEY ?? "slaude-test-secret",
  };
  suite("S3ObjectStore", () => new S3ObjectStore(cfg));
}
