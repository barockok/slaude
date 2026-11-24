import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PackError,
  apply,
  clear,
  create,
  diff,
  encodeHeader,
  listArchive,
  liveBytes,
  loadIndex,
  localPacker,
  safeRel,
  saveIndex,
  scan,
  selects,
  validateListing,
  zstdAvailable,
  type ApplyState,
  type IndexEntry,
  type PackIndex,
  type TarEntry,
} from "../../src/box/boxd/pack";
import { DEFAULT_IGNORE, LocalObjectStore, RootMissingError, flushTree, isIgnored, latestTreeManifest, type PackFilter } from "../../src/storage";

const tmps: string[] = [];
const tmp = (n: string): string => {
  const d = mkdtempSync(join(tmpdir(), `slaude-packer-${n}-`));
  tmps.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmps) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* a read-only tree a test left: the OS temp cleaner takes it */
    }
  }
});

const ALL: PackFilter = { kind: "all", exclude: [] };
const WX: PackFilter = { kind: "ignored", names: DEFAULT_IGNORE };

/** Every path under a directory, symlinks not followed. */
function walkAll(root: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const d of readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      out.push(r);
      if (d.isDirectory()) walk(join(abs, d.name), r);
    }
  };
  walk(root, "");
  return out.sort();
}

/** A deterministic generator, so a failing property run can be repeated. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const BLOCK = 512;
const text = (s: string) => new TextEncoder().encode(s);

/** Build a plain tar by hand: what this packer would never write. */
function rawTar(dir: string, parts: { entry: Partial<TarEntry> & { path: string }; flag?: string; body?: string }[], opts: { end?: boolean } = {}): string {
  const chunks: Uint8Array[] = [];
  for (const p of parts) {
    const body = text(p.body ?? "");
    const e: TarEntry = { type: "file", mode: 0o644, size: body.length, mtime: 1_700_000_000, linkname: "", ...p.entry };
    chunks.push(encodeHeader(e, p.flag));
    if (body.length > 0) {
      const padded = new Uint8Array(Math.ceil(body.length / BLOCK) * BLOCK);
      padded.set(body);
      chunks.push(padded);
    }
  }
  if (opts.end !== false) chunks.push(new Uint8Array(BLOCK * 2));
  const path = join(dir, `hostile-${Math.random().toString(36).slice(2, 10)}.tar`);
  writeFileSync(path, Buffer.concat(chunks));
  return path;
}

const file = (path: string, body = "x", extra: Partial<TarEntry> = {}) => ({ entry: { path, ...extra }, body });
const dir = (path: string, extra: Partial<TarEntry> = {}) => ({ entry: { path, type: "dir" as const, mode: 0o755, ...extra } });
const link = (path: string, target: string) => ({ entry: { path, type: "link" as const, mode: 0o777, linkname: target } });
const hard = (path: string, target: string) => ({ entry: { path, type: "hardlink" as const, linkname: target } });

describe("pack filters", () => {
  test("the workspace extras are exactly what the per-file sync ignores (property over random paths)", () => {
    const next = rng(20261124);
    const pool = ["src", "lib", "a", "b.ts", "node_modules", ".cache", "__pycache__", ".venv", "dist", ".slaude-sync", ".slaude-sync.tmp1", "x.slaude-sync.ab", "node_modules2", "NODE_MODULES", ".venv.bak", "pkg"];
    const lists: string[][] = [DEFAULT_IGNORE, [], ["dist"], ["node_modules", "dist", "pkg"]];
    let checked = 0;
    for (const names of lists) {
      const wx: PackFilter = { kind: "ignored", names };
      for (let i = 0; i < 3000; i++) {
        const depth = 1 + Math.floor(next() * 5);
        const rel = Array.from({ length: depth }, () => pool[Math.floor(next() * pool.length)]!).join("/");
        const inWs = !isIgnored(rel, names);
        const inWx = selects(wx, rel);
        expect(inWs !== inWx).toBe(true); // exactly one of the two holds the path
        checked++;
      }
    }
    expect(checked).toBe(12_000);
  });

  test("on a real tree, what flushTree stores and what the extras scan holds are disjoint and together are everything", async () => {
    const next = rng(7);
    const root = tmp("partition");
    const names = ["src", "node_modules", ".cache", "pkg", "a.txt", "b.js", ".venv", "deep", "__pycache__"];
    let made = 0;
    const grow = (abs: string, depth: number): void => {
      for (const name of names) {
        if (next() < 0.45) continue;
        const p = join(abs, name);
        if (name.includes(".") && !name.startsWith(".")) {
          writeFileSync(p, name);
          made++;
        } else if (depth < 3) {
          mkdirSync(p);
          made++;
          grow(p, depth + 1);
        } else if (next() < 0.5) {
          symlinkSync("../a.txt", p);
          made++;
        } else {
          mkdirSync(p);
          made++;
        }
      }
    };
    grow(root, 0);
    expect(made).toBeGreaterThan(40);

    const store = new LocalObjectStore(tmp("store"));
    await flushTree(store, "ws-partition", [{ name: "ws", dir: root }], { epoch: 1, isCurrent: () => true, ignore: DEFAULT_IGNORE });
    const m = (await latestTreeManifest(store, "ws-partition"))!.manifest;
    const ws = new Set([...m.dirs, ...Object.keys(m.files)].map((k) => k.slice("ws/".length)));
    const wx = new Set(scan(root, WX).keys());
    const all = walkAll(root);
    expect(wx.size).toBeGreaterThan(0);
    expect(ws.size).toBeGreaterThan(0);
    for (const p of all) expect(ws.has(p) !== wx.has(p)).toBe(true);
    expect(ws.size + wx.size).toBe(all.length);
  });

  test("a home filter drops the excluded paths and everything below them", () => {
    const f: PackFilter = { kind: "all", exclude: [".cache/huggingface", "big"] };
    expect(selects(f, ".cache")).toBe(true);
    expect(selects(f, ".cache/pip/x")).toBe(true);
    expect(selects(f, ".cache/huggingface")).toBe(false);
    expect(selects(f, ".cache/huggingface/hub/m")).toBe(false);
    expect(selects(f, ".cache/huggingface2")).toBe(true);
    expect(selects(f, "big")).toBe(false);
    expect(selects(f, "bigger")).toBe(true);

    const root = tmp("home");
    mkdirSync(join(root, ".cache", "huggingface", "hub"), { recursive: true });
    mkdirSync(join(root, ".cache", "pip"), { recursive: true });
    writeFileSync(join(root, ".cache", "huggingface", "hub", "model"), "m");
    writeFileSync(join(root, ".cache", "pip", "wheel"), "w");
    writeFileSync(join(root, ".bashrc"), "b");
    expect([...scan(root, f).keys()]).toEqual([".bashrc", ".cache", ".cache/pip", ".cache/pip/wheel"]);

    clear(root, f);
    expect(walkAll(root)).toEqual([".cache", ".cache/huggingface", ".cache/huggingface/hub", ".cache/huggingface/hub/model"]);
  });

  test("clearing the extras leaves the workspace's own files", () => {
    const root = tmp("ws");
    mkdirSync(join(root, "pkg", "node_modules", "m"), { recursive: true });
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "pkg", "node_modules", "m", "i.js"), "1");
    writeFileSync(join(root, "pkg", "index.ts"), "1");
    writeFileSync(join(root, "README.md"), "1");
    clear(root, WX);
    expect(walkAll(root)).toEqual(["README.md", "pkg", "pkg/index.ts"]);
  });
});

describe("pack index", () => {
  const e = (over: Partial<IndexEntry> = {}): IndexEntry => ({ type: "file", size: 1, mtimeMs: 1000, ctimeMs: 1000, ino: 1, mode: 0o644, nlink: 1, ...over });
  const idx = (o: Record<string, IndexEntry>): PackIndex => new Map(Object.entries(o));

  const table: [string, PackIndex, PackIndex, string[], string[]][] = [
    ["no change", idx({ a: e() }), idx({ a: e() }), [], []],
    ["a new file", idx({ a: e() }), idx({ a: e(), b: e({ ino: 2 }) }), ["b"], []],
    ["a removed file", idx({ a: e(), b: e() }), idx({ a: e() }), [], ["b"]],
    ["content changed (mtime)", idx({ a: e() }), idx({ a: e({ mtimeMs: 2000 }) }), ["a"], []],
    ["content changed, mtime restored (ctime)", idx({ a: e() }), idx({ a: e({ ctimeMs: 2000 }) }), ["a"], []],
    ["size changed", idx({ a: e() }), idx({ a: e({ size: 2 }) }), ["a"], []],
    ["replaced by another inode", idx({ a: e() }), idx({ a: e({ ino: 9 }) }), ["a"], []],
    ["mode changed", idx({ a: e() }), idx({ a: e({ mode: 0o755 }) }), ["a"], []],
    ["a new hard link to an old file", idx({ a: e() }), idx({ a: e({ nlink: 2 }), b: e({ nlink: 2 }) }), ["a", "b"], []],
    ["a directory's times alone are not a change", idx({ d: e({ type: "dir", size: 0 }) }), idx({ d: e({ type: "dir", size: 0, mtimeMs: 5, ctimeMs: 5 }) }), [], []],
    ["a directory's mode is", idx({ d: e({ type: "dir", mode: 0o755 }) }), idx({ d: e({ type: "dir", mode: 0o700 }) }), ["d"], []],
    ["a symlink retargeted", idx({ l: e({ type: "link", target: "a" }) }), idx({ l: e({ type: "link", target: "b" }) }), ["l"], []],
    ["a file became a directory: removed first, then written", idx({ x: e() }), idx({ x: e({ type: "dir" }), "x/y": e() }), ["x", "x/y"], ["x"]],
    ["a directory became a symlink", idx({ x: e({ type: "dir" }), "x/y": e() }), idx({ x: e({ type: "link", target: "/etc" }) }), ["x"], ["x"]],
    ["only the top of a removed tree is listed", idx({ d: e({ type: "dir" }), "d-x": e(), "d/a": e(), "d/s": e({ type: "dir" }), "d/s/b": e() }), idx({}), [], ["d", "d-x"]],
  ];
  for (const [name, prev, next, changed, removed] of table) {
    test(`diff: ${name}`, () => {
      expect(diff(prev, next)).toEqual({ changed, removed });
    });
  }

  test("an index survives a save and a load, with the manifest id it was recorded for", () => {
    const p = join(tmp("idx"), "state", "u.index.json");
    const index = idx({ a: e(), l: e({ type: "link", target: "a" }), d: e({ type: "dir" }) });
    saveIndex(p, "0000000001-000003", index);
    const back = loadIndex(p)!;
    expect(back.base).toBe("0000000001-000003");
    expect([...back.entries]).toEqual([...index]);
    expect(diff(index, back.entries)).toEqual({ changed: [], removed: [] });
    writeFileSync(p, "{ not json");
    expect(loadIndex(p)).toBeNull();
    expect(loadIndex(join(tmp("idx"), "none.json"))).toBeNull();
  });

  test("live bytes count a hard-linked file once", () => {
    expect(liveBytes(idx({ a: e({ size: 10, nlink: 2, ino: 5 }), b: e({ size: 10, nlink: 2, ino: 5 }), c: e({ size: 3, ino: 6 }), d: e({ type: "dir", size: 0 }) }))).toBe(13);
  });
});

function sampleTree(root: string): void {
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "empty", "nested"), { recursive: true });
  mkdirSync(join(root, "private"), { recursive: true });
  writeFileSync(join(root, "bin", "tool"), "#!/bin/sh\necho hi\n");
  chmodSync(join(root, "bin", "tool"), 0o755);
  writeFileSync(join(root, "private", "notes"), "secret-free notes");
  chmodSync(join(root, "private", "notes"), 0o600);
  chmodSync(join(root, "private"), 0o700);
  writeFileSync(join(root, "zero"), "");
  writeFileSync(join(root, "big.bin"), Buffer.alloc(700_000, 7));
  writeFileSync(join(root, "unicode-é中.txt"), "u");
  const long = join(root, "l".repeat(60), "m".repeat(60));
  mkdirSync(long, { recursive: true });
  writeFileSync(join(long, `${"n".repeat(90)}.txt`), "long name");
  symlinkSync("bin/tool", join(root, "tool-link"));
  symlinkSync("/nonexistent/absolute/target", join(root, "abs-link"));
  symlinkSync("t".repeat(150), join(root, "long-link"));
  linkSync(join(root, "bin", "tool"), join(root, "bin", "tool-hard"));
  utimesSync(join(root, "zero"), 1_600_000_000, 1_600_000_000);
}

for (const compress of [true, false]) {
  describe(`pack archive round trip (${compress ? "zstd" : "plain tar"})`, () => {
    test("modes, symlinks, hard links, empty directories and long names come back", async () => {
      if (compress) expect(zstdAvailable()).toBe(true);
      const src = tmp("src");
      sampleTree(src);
      const index = scan(src, ALL);
      const a = await create(src, [...index.keys()], [], { spoolDir: tmp("spool"), compress });
      expect(a.entries).toBe(index.size);
      expect(a.unsettled).toEqual([]);
      expect(a.bytes).toBe(statSync(a.path).size);
      expect(a.hash).toBe(new Bun.CryptoHasher("sha256").update(readFileSync(a.path)).digest("hex"));
      const magic = [...readFileSync(a.path).subarray(0, 4)];
      expect(magic[0] === 0x28 && magic[1] === 0xb5).toBe(compress);

      const listing = await listArchive(a.path);
      validateListing(listing);
      expect(listing.map((e) => e.path)).toEqual([...index.keys()]);
      expect(listing.find((e) => e.path === "bin/tool-hard")).toMatchObject({ type: "hardlink", linkname: "bin/tool" });

      const dst = tmp("dst");
      const r = await apply(a.path, dst);
      expect(r).toEqual({ written: index.size, skipped: 0 });
      expect(walkAll(dst)).toEqual(walkAll(src));
      expect(readFileSync(join(dst, "bin", "tool"), "utf8")).toBe("#!/bin/sh\necho hi\n");
      expect(lstatSync(join(dst, "bin", "tool")).mode & 0o777).toBe(0o755);
      expect(lstatSync(join(dst, "private", "notes")).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(dst, "private")).mode & 0o777).toBe(0o700);
      expect(readdirSync(join(dst, "empty", "nested"))).toEqual([]);
      expect(lstatSync(join(dst, "zero")).size).toBe(0);
      expect(Math.floor(lstatSync(join(dst, "zero")).mtimeMs / 1000)).toBe(1_600_000_000);
      expect(Buffer.compare(readFileSync(join(dst, "big.bin")), Buffer.alloc(700_000, 7))).toBe(0);
      expect(readlinkSync(join(dst, "tool-link"))).toBe("bin/tool");
      expect(readlinkSync(join(dst, "abs-link"))).toBe("/nonexistent/absolute/target");
      expect(readlinkSync(join(dst, "long-link"))).toBe("t".repeat(150));
      expect(readFileSync(join(dst, "l".repeat(60), "m".repeat(60), `${"n".repeat(90)}.txt`), "utf8")).toBe("long name");
      const one = lstatSync(join(dst, "bin", "tool"));
      const two = lstatSync(join(dst, "bin", "tool-hard"));
      expect(one.ino).toBe(two.ino);
      expect(one.nlink).toBe(2);
      // Applied on another disk, the tree compares equal to itself: the rebuilt index is the base of the next delta.
      expect(diff(scan(dst, ALL), scan(dst, ALL))).toEqual({ changed: [], removed: [] });
    });

    test("a delta layer carries only what changed, and its removed paths are deleted first", async () => {
      const src = tmp("src");
      const spoolDir = tmp("spool");
      sampleTree(src);
      const first = scan(src, ALL);
      const full = await create(src, [...first.keys()], [], { spoolDir, compress });

      writeFileSync(join(src, "bin", "new"), "n");
      rmSync(join(src, "empty"), { recursive: true });
      rmSync(join(src, "tool-link"));
      mkdirSync(join(src, "tool-link")); // a symlink became a directory
      writeFileSync(join(src, "tool-link", "inside"), "i");
      rmSync(join(src, "zero"));
      const second = scan(src, ALL);
      const d = diff(first, second);
      expect(d.removed).toEqual(["empty", "tool-link", "zero"]);
      expect(d.changed).toEqual(["bin/new", "tool-link", "tool-link/inside"]);
      const delta = await create(src, d.changed, d.removed, { spoolDir, compress });
      expect(delta.entries).toBe(3);
      expect(delta.removed).toEqual(d.removed);
      expect(delta.bytes).toBeLessThan(full.bytes);

      const dst = tmp("dst");
      const state: ApplyState = { written: new Set() };
      await apply(full.path, dst, { state });
      await apply(delta.path, dst, { removed: delta.removed, state });
      expect(walkAll(dst)).toEqual(walkAll(src));
      expect(lstatSync(join(dst, "tool-link")).isDirectory()).toBe(true);
      expect(readFileSync(join(dst, "tool-link", "inside"), "utf8")).toBe("i");
    });
  });
}

describe("pack apply: hostile archives", () => {
  /** A target directory beside a directory that must stay untouched. */
  function arena() {
    const base = tmp("arena");
    const root = join(base, "root");
    const outside = join(base, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, "keep"), "untouched");
    const untouched = (): void => {
      expect(readdirSync(outside)).toEqual(["keep"]);
      expect(readFileSync(join(outside, "keep"), "utf8")).toBe("untouched");
      expect(readdirSync(base).sort()).toEqual(["outside", "root"]);
    };
    return { base, root, outside, untouched, tars: tmp("tars") };
  }

  const refused: [string, Parameters<typeof rawTar>[1], RegExp][] = [
    ["a .. segment", [file("../outside/evil")], /unsafe path/],
    ["a .. segment in the middle", [dir("a"), file("a/../../outside/evil")], /unsafe path/],
    ["an absolute path", [file("/tmp/slaude-pack-evil")], /unsafe path/],
    ["a . segment", [file("./a")], /unsafe path/],
    ["an empty segment", [file("a//b")], /unsafe path/],
    ["a character device", [{ entry: { path: "dev-null" }, flag: "3" }], /character device/],
    ["a block device", [{ entry: { path: "disk" }, flag: "4" }], /block device/],
    ["a pipe", [{ entry: { path: "fifo" }, flag: "6" }], /pipe/],
    ["a GNU long name record", [{ entry: { path: "././@LongLink" }, flag: "L", body: "x" }], /GNU long name/],
    ["an unknown entry type", [{ entry: { path: "weird" }, flag: "Z" }], /unknown type/],
    ["a symlink used as a directory in the same archive", [link("lnk", "../outside"), file("lnk/evil")], /not a directory/],
    ["the same, child first", [file("lnk/evil"), link("lnk", "../outside")], /used as a directory/],
    ["a file used as a directory", [file("f"), file("f/child")], /not a directory/],
    ["the same path twice", [file("a", "1"), link("a", "../outside/keep")], /appears twice/],
    ["a hard link to a path outside", [hard("h", "../outside/keep")], /unsafe target/],
    ["a hard link to an absolute path", [hard("h", "/etc/hosts")], /unsafe target/],
    ["a hard link to a path the archive does not hold", [hard("h", "not-here")], /regular file earlier/],
    ["a hard link to a symlink", [link("l", "../outside/keep"), hard("h", "l")], /regular file earlier/],
    ["a hard link to a later entry", [hard("h", "f"), file("f")], /regular file earlier/],
  ];
  for (const [name, parts, pattern] of refused) {
    test(`refuses ${name} and writes nothing`, async () => {
      const a = arena();
      // A harmless first entry: the listing is checked in full before anything is written, so it must not land either.
      const tar = rawTar(a.tars, [file("innocent"), ...parts]);
      const err = await apply(tar, a.root).catch((e) => e);
      expect(err).toBeInstanceOf(PackError);
      expect(String(err.message)).toMatch(pattern);
      expect(readdirSync(a.root)).toEqual([]);
      a.untouched();
    });
  }

  test("a symlink from an earlier layer used as a directory by a later layer is refused, not followed", async () => {
    const a = arena();
    const state: ApplyState = { written: new Set() };
    await apply(rawTar(a.tars, [link("lnk", "../outside"), dir("real")]), a.root, { state });
    expect(readlinkSync(join(a.root, "lnk"))).toBe("../outside");
    for (const foreign of ["reject", "skip"] as const) {
      const err = await apply(rawTar(a.tars, [file("lnk/evil", "pwned")]), a.root, { state, foreign }).catch((e) => e);
      expect(err).toBeInstanceOf(PackError);
      expect(String(err.message)).toMatch(/goes through 'lnk', which is a symlink/);
    }
    const deep = await apply(rawTar(a.tars, [dir("lnk/sub"), file("lnk/sub/evil")]), a.root, { state }).catch((e) => e);
    expect(deep).toBeInstanceOf(PackError);
    a.untouched();
  });

  test("a symlink chain through a nested link is refused at the first link", async () => {
    const a = arena();
    const state: ApplyState = { written: new Set() };
    await apply(rawTar(a.tars, [dir("d"), link("d/up", ".."), link("d/out", "../../outside")]), a.root, { state });
    await expect(apply(rawTar(a.tars, [file("d/up/d/out/evil")]), a.root, { state })).rejects.toThrow(/goes through 'd\/up'/);
    a.untouched();
  });

  test("a later layer cannot write through a symlink that sits at its own path", async () => {
    const a = arena();
    const state: ApplyState = { written: new Set() };
    await apply(rawTar(a.tars, [link("target", "../outside/keep")]), a.root, { state });
    await expect(apply(rawTar(a.tars, [file("target", "overwritten")]), a.root, { state })).rejects.toThrow(/did not remove it first/);
    a.untouched();
    // With the removal the layer is a legitimate type change: the link goes, a file takes its place.
    await apply(rawTar(a.tars, [file("target", "mine")]), a.root, { state, removed: ["target"] });
    expect(lstatSync(join(a.root, "target")).isFile()).toBe(true);
    a.untouched();
  });

  test("a path changing type between layers is refused unless the layer removes it first", async () => {
    const cases: [string, ReturnType<typeof file | typeof dir | typeof link>, ReturnType<typeof file | typeof dir | typeof link>][] = [
      ["file to directory", file("x"), dir("x")],
      ["directory to file", dir("x"), file("x")],
      ["file to symlink", file("x"), link("x", "elsewhere")],
      ["directory to symlink", dir("x"), link("x", "elsewhere")],
      ["symlink to directory", link("x", "elsewhere"), dir("x")],
    ];
    for (const [name, first, second] of cases) {
      const a = arena();
      const state: ApplyState = { written: new Set() };
      await apply(rawTar(a.tars, [first]), a.root, { state });
      const before = lstatSync(join(a.root, "x"));
      const err = await apply(rawTar(a.tars, [second]), a.root, { state }).catch((e) => e);
      expect(err, name).toBeInstanceOf(PackError);
      expect(String(err.message)).toMatch(/did not remove it first/);
      expect(lstatSync(join(a.root, "x")).mode).toBe(before.mode);
      await apply(rawTar(a.tars, [second]), a.root, { state, removed: ["x"] });
      a.untouched();
    }
  });

  test("set-uid, set-gid and sticky bits are stripped from files and directories", async () => {
    const a = arena();
    await apply(rawTar(a.tars, [dir("d", { mode: 0o6775 }), file("d/suid", "#!/bin/sh", { mode: 0o4755 }), file("sgid", "x", { mode: 0o2755 }), file("sticky", "x", { mode: 0o1644 }), dir("t", { mode: 0o1777 })]), a.root);
    expect(lstatSync(join(a.root, "d", "suid")).mode & 0o7777).toBe(0o755);
    expect(lstatSync(join(a.root, "sgid")).mode & 0o7777).toBe(0o755);
    expect(lstatSync(join(a.root, "sticky")).mode & 0o7777).toBe(0o644);
    expect(lstatSync(join(a.root, "d")).mode & 0o7777).toBe(0o775);
    expect(lstatSync(join(a.root, "t")).mode & 0o7777).toBe(0o777);
  });

  test("entries are written as the user running the packer, whatever the archive says", async () => {
    const a = arena();
    const header = encodeHeader({ path: "owned", type: "file", mode: 0o644, size: 0, mtime: 0, linkname: "" });
    // Rewrite uid and gid to 0 is what the packer does; a hostile archive says anything. Neither is read back.
    const tar = join(a.tars, "owner.tar");
    writeFileSync(tar, Buffer.concat([header, new Uint8Array(BLOCK * 2)]));
    await apply(tar, a.root);
    expect(lstatSync(join(a.root, "owned")).uid).toBe(process.getuid!());
  });

  test("a replaced file is created anew, never written through an existing hard link", async () => {
    const a = arena();
    const state: ApplyState = { written: new Set() };
    await apply(rawTar(a.tars, [file("a", "original"), hard("b", "a")]), a.root, { state });
    expect(lstatSync(join(a.root, "a")).nlink).toBe(2);
    await apply(rawTar(a.tars, [file("b", "changed")]), a.root, { state });
    expect(readFileSync(join(a.root, "a"), "utf8")).toBe("original");
    expect(readFileSync(join(a.root, "b"), "utf8")).toBe("changed");
  });

  test("removed paths are confined too", async () => {
    const a = arena();
    const empty = rawTar(a.tars, []);
    for (const bad of ["../outside/keep", "/etc/hosts", "a/../../outside", ""]) {
      await expect(apply(empty, a.root, { removed: [bad] })).rejects.toThrow(/unsafe removed path/);
    }
    // A removal below a symlink deletes nothing behind the link.
    symlinkSync("../outside", join(a.root, "lnk"));
    await expect(apply(empty, a.root, { removed: ["lnk/keep"] })).rejects.toThrow(/goes through 'lnk'/);
    a.untouched();
    // Removing the link itself removes the link, never what it points at.
    await apply(empty, a.root, { removed: ["lnk"] });
    expect(existsSync(join(a.root, "lnk"))).toBe(false);
    a.untouched();
  });

  test("a bad checksum, a truncated archive and a missing end marker are refused", async () => {
    const a = arena();
    const good = readFileSync(rawTar(a.tars, [file("a", "hello")]));
    const flipped = Buffer.from(good);
    flipped[0] = flipped[0]! ^ 0xff;
    const bad = join(a.tars, "bad-sum.tar");
    writeFileSync(bad, flipped);
    await expect(apply(bad, a.root)).rejects.toThrow(/bad checksum/);
    const cut = join(a.tars, "cut.tar");
    writeFileSync(cut, good.subarray(0, BLOCK + 3));
    await expect(apply(cut, a.root)).rejects.toThrow(/truncated/);
    await expect(apply(rawTar(a.tars, [file("a", "hello")], { end: false }), a.root)).rejects.toThrow(/no end marker/);
    expect(readdirSync(a.root)).toEqual([]);
  });

  test("with a filter, entries and removals outside the unit are skipped, never written", async () => {
    const a = arena();
    writeFileSync(join(a.root, "README.md"), "the workspace's own");
    const tar = rawTar(a.tars, [file("README.md", "overwritten by the extras"), dir("node_modules"), file("node_modules/m.js", "ok"), dir("src"), file("src/evil.ts", "x")]);
    const r = await apply(tar, a.root, { filter: WX, removed: ["README.md"] });
    expect(r).toEqual({ written: 2, skipped: 4 });
    expect(readFileSync(join(a.root, "README.md"), "utf8")).toBe("the workspace's own");
    expect(existsSync(join(a.root, "src"))).toBe(false);
    expect(readFileSync(join(a.root, "node_modules", "m.js"), "utf8")).toBe("ok");
  });

  test("in skip mode, a path blocked by something another unit owns is left out, and nothing goes through it", async () => {
    const a = arena();
    // The workspace's own tree holds a symlink and a file where the stored extras expect directories.
    symlinkSync("../outside", join(a.root, "pkg"));
    writeFileSync(join(a.root, "lib"), "a file now");
    const tar = rawTar(a.tars, [dir("pkg/node_modules"), file("pkg/node_modules/evil.js"), dir("lib/node_modules"), file("lib/node_modules/x.js"), dir("node_modules"), file("node_modules/ok.js", "ok")]);
    await expect(apply(tar, a.root, { filter: WX })).rejects.toThrow(/goes through 'pkg'/);
    const r = await apply(tar, a.root, { filter: WX, foreign: "skip" });
    expect(r).toEqual({ written: 2, skipped: 4 });
    expect(readFileSync(join(a.root, "lib"), "utf8")).toBe("a file now");
    expect(readFileSync(join(a.root, "node_modules", "ok.js"), "utf8")).toBe("ok");
    a.untouched();
  });

  test("validateListing accepts what create writes, and safeRel is the path rule", () => {
    expect(safeRel("a/b")).toBe(true);
    expect(safeRel("a\\b")).toBe(true); // a legal file name on the nodes' filesystem
    for (const bad of ["", "/a", "a/", "a//b", ".", "..", "a/./b", "a/../b", "a\0b"]) expect(safeRel(bad)).toBe(false);
    validateListing([
      { path: "d", type: "dir", mode: 0o755, size: 0, mtime: 0, linkname: "" },
      { path: "d/f", type: "file", mode: 0o644, size: 1, mtime: 0, linkname: "" },
      { path: "d/h", type: "hardlink", mode: 0o644, size: 0, mtime: 0, linkname: "d/f" },
      { path: "d/l", type: "link", mode: 0o777, size: 0, mtime: 0, linkname: "../../anywhere" },
    ]);
  });
});

describe("local packer", () => {
  function unit(name: string, filter: PackFilter = ALL) {
    const base = tmp(name);
    const root = join(base, "root");
    mkdirSync(root);
    return { root, filter, indexPath: join(base, "state", "u.index.json") };
  }

  test("pack is null when nothing changed, a delta after a change, and full without a usable index", async () => {
    const packer = localPacker({ spoolDir: tmp("spool") });
    const u = unit("a");
    writeFileSync(join(u.root, "a"), "1");
    const first = (await packer.pack(u, { base: null, compact: false }))!;
    expect(first.full).toBe(true);
    expect(first.entries).toBe(1);
    expect(first.liveBytes).toBe(1);
    await first.commit("0000000001-000001");
    await first.dispose();
    expect(existsSync(first.path)).toBe(false);

    expect(await packer.pack(u, { base: "0000000001-000001", compact: false })).toBeNull();
    expect(await packer.pack(u, { base: "0000000001-000001", compact: true })).toBeNull();

    writeFileSync(join(u.root, "b"), "22");
    rmSync(join(u.root, "a"));
    const delta = (await packer.pack(u, { base: "0000000001-000001", compact: false }))!;
    expect(delta.full).toBe(false);
    expect(delta.entries).toBe(1);
    expect(delta.removed).toEqual(["a"]);
    await delta.dispose(); // not committed: the index still describes the first manifest

    const compacted = (await packer.pack(u, { base: "0000000001-000001", compact: true }))!;
    expect(compacted.full).toBe(true);
    expect(compacted.removed).toEqual([]);
    await compacted.dispose();

    // The store stands somewhere this disk has no index for: a delta would be against the wrong base.
    const other = (await packer.pack(u, { base: "0000000002-000001", compact: false }))!;
    expect(other.full).toBe(true);
    await other.dispose();
    expect(readdirSync(packer.spoolDir)).toEqual([]);
  });

  test("a missing root is refused: it is not an empty tree", async () => {
    const packer = localPacker({ spoolDir: tmp("spool") });
    const u = unit("gone");
    rmSync(u.root, { recursive: true });
    await expect(packer.pack(u, { base: null, compact: false })).rejects.toBeInstanceOf(RootMissingError);
  });

  test("apply replaces the unit's paths, keeps the rest of the directory, and leaves an index a delta can build on", async () => {
    const packer = localPacker({ spoolDir: tmp("spool") });
    const a = unit("a", WX);
    mkdirSync(join(a.root, "node_modules", "m"), { recursive: true });
    writeFileSync(join(a.root, "node_modules", "m", "index.js"), "module.exports = 1;");
    writeFileSync(join(a.root, "app.ts"), "the workspace's own");
    const layer = (await packer.pack(a, { base: null, compact: false }))!;
    expect(layer.entries).toBe(3);

    const b = unit("b", WX);
    mkdirSync(join(b.root, "node_modules", "stale"), { recursive: true });
    writeFileSync(join(b.root, "node_modules", "stale", "old.js"), "old");
    writeFileSync(join(b.root, "app.ts"), "b's workspace file");
    const r = await packer.apply(b, { id: "0000000001-000001", layers: [{ path: layer.path, hash: layer.hash, removed: [] }] });
    expect(r).toEqual({ liveBytes: 19 });
    expect(walkAll(b.root)).toEqual(["app.ts", "node_modules", "node_modules/m", "node_modules/m/index.js"]);
    expect(readFileSync(join(b.root, "app.ts"), "utf8")).toBe("b's workspace file");
    expect(await packer.pack(b, { base: "0000000001-000001", compact: false })).toBeNull();

    await packer.clear(b);
    expect(walkAll(b.root)).toEqual(["app.ts"]);
    expect(existsSync(b.indexPath)).toBe(false);
    await layer.dispose();
  });

  test("a read-only tree (a module cache) packs, applies, takes a later layer, and can be cleared", async () => {
    const packer = localPacker({ spoolDir: tmp("spool") });
    const a = unit("a");
    const mod = join(a.root, "go", "pkg", "mod", "example.test", "m@v1");
    mkdirSync(mod, { recursive: true });
    writeFileSync(join(mod, "m.go"), "package m");
    chmodSync(join(mod, "m.go"), 0o444);
    chmodSync(mod, 0o555);
    try {
      const l1 = (await packer.pack(a, { base: null, compact: false }))!;
      await l1.commit("0000000001-000001");
      chmodSync(mod, 0o755);
      writeFileSync(join(mod, "extra.go"), "package m // added");
      chmodSync(mod, 0o555);
      const l2 = (await packer.pack(a, { base: "0000000001-000001", compact: false }))!;
      expect(l2.full).toBe(false);

      const b = unit("b");
      await packer.apply(b, {
        id: "0000000001-000002",
        layers: [
          { path: l1.path, hash: l1.hash, removed: [] },
          { path: l2.path, hash: l2.hash, removed: l2.removed },
        ],
      });
      const bmod = join(b.root, "go", "pkg", "mod", "example.test", "m@v1");
      expect(readdirSync(bmod).sort()).toEqual(["extra.go", "m.go"]);
      expect(lstatSync(bmod).mode & 0o777).toBe(0o555);
      expect(lstatSync(join(bmod, "m.go")).mode & 0o777).toBe(0o444);
      await packer.clear(b);
      expect(readdirSync(b.root)).toEqual([]);
    } finally {
      chmodSync(mod, 0o755);
    }
  });

  test("a tree over the ceiling is refused before any archive is built", async () => {
    const packer = localPacker({ spoolDir: tmp("spool") });
    const u = unit("big");
    writeFileSync(join(u.root, "f"), "x".repeat(1000));
    await expect(packer.pack(u, { base: null, compact: false, maxLiveBytes: 999 })).rejects.toThrow(/pack refused/);
    expect(readdirSync(packer.spoolDir)).toEqual([]);
  });
});
