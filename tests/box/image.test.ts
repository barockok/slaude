/**
 * The node's box image cache (box plan, Phase 4), with a fake runner and a
 * local OCI layout fixture: fetch by digest, the digest check, the image
 * checks, eviction order, offline import, and a fake registry (a layout
 * served by a tiny static server) for pull and digest mismatch.
 *
 * The real runner (skopeo, umoci) is exercised only through a fake exec: its
 * argv is asserted, the tools themselves are not run here.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BoxImageError, cliImageRunner, imageBootFailure, layoutDigest, makeImageStore, rootfsProblems, treeBytes, type ImageRunner } from "../../src/box/image";
import { standInDigestFor } from "../../src/box/definition";
import { BootFailure, failureText } from "../../src/gateway/core/failure-codes";
import { fakeRunner, goodRootfs, layoutFiles, unpackTestLayout, writeOciLayout } from "../helpers/oci-layout";

const REPO = "ghcr.io/example/boxes/ruby-dev";
const roots: string[] = [];
const tmp = (tag: string) => {
  const d = mkdtempSync(join(tmpdir(), `slaude-image-${tag}-`));
  roots.push(d);
  return d;
};
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

/** A registry folder with `n` images of different content, and a store over it. */
function setup(o: { images?: Array<Record<string, string>>; budgetMb?: number; delayMs?: number; problems?: (r: string) => string[] } = {}) {
  const reg = tmp("registry");
  const registry: Record<string, string> = {};
  const refs: Array<{ image: string; digest: string }> = [];
  (o.images ?? [goodRootfs()]).forEach((files, i) => {
    const dir = join(reg, `img${i}`);
    mkdirSync(dir, { recursive: true });
    const digest = writeOciLayout(dir, files);
    registry[`${REPO}@${digest}`] = dir;
    refs.push({ image: `${REPO}@${digest}`, digest });
  });
  const clock = { now: 1_000 };
  const runner = fakeRunner(registry, { delayMs: o.delayMs });
  const logs: string[] = [];
  const store = makeImageStore({ dir: tmp("boxdir"), runner, budgetMb: o.budgetMb ?? 0, now: () => clock.now, log: (l) => void logs.push(l), ...(o.problems ? { problems: o.problems } : {}) });
  return { store, runner, refs, clock, logs, registry };
}
const fails = async (p: Promise<unknown>): Promise<BoxImageError> => {
  const e = await p.catch((x) => x);
  expect(e).toBeInstanceOf(BoxImageError);
  return e as BoxImageError;
};

describe("the OCI layout fixture and its digest", () => {
  test("the digest is the manifest's own hash, named by the index", () => {
    const dir = tmp("layout");
    const digest = writeOciLayout(dir);
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(layoutDigest(dir)).toBe(digest);
    // Different content, different digest.
    const other = tmp("layout");
    expect(writeOciLayout(other, goodRootfs({ "usr/bin/ruby": "ruby\n" }))).not.toBe(digest);
  });

  test("a manifest blob that was edited after the fact is refused", () => {
    const dir = tmp("layout");
    const digest = writeOciLayout(dir);
    const blob = join(dir, "blobs", "sha256", digest.slice(7));
    writeFileSync(blob, readFileSync(blob, "utf8").replace('"schemaVersion":2', '"schemaVersion": 2'));
    expect(() => layoutDigest(dir)).toThrow("does not hash to the digest it is stored under");
  });

  test("not a layout, an empty index, two images, a missing manifest", () => {
    expect(() => layoutDigest(tmp("empty"))).toThrow("is not an OCI layout");
    const none = tmp("layout");
    writeFileSync(join(none, "index.json"), JSON.stringify({ manifests: [] }));
    expect(() => layoutDigest(none)).toThrow("holds 0 images");
    const two = tmp("layout");
    const d = writeOciLayout(two);
    writeFileSync(join(two, "index.json"), JSON.stringify({ manifests: [{ digest: d }, { digest: d }] }));
    expect(() => layoutDigest(two)).toThrow("holds 2 images");
    const gone = tmp("layout");
    writeFileSync(join(gone, "index.json"), JSON.stringify({ manifests: [{ digest: `sha256:${"a".repeat(64)}` }] }));
    expect(() => layoutDigest(gone)).toThrow("does not hold the manifest");
  });
});

describe("what a box needs of an image", () => {
  const rootfs = (files: Record<string, string>): string => {
    const d = tmp("rootfs");
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(dirname(join(d, p)), { recursive: true });
      writeFileSync(join(d, p), body);
    }
    return d;
  };
  const without = (key: string) => Object.fromEntries(Object.entries(goodRootfs()).filter(([k]) => k !== key));

  test("a good image passes", () => {
    expect(rootfsProblems(rootfs(goodRootfs()))).toEqual([]);
  });

  test.each([
    ["no passwd", without("etc/passwd"), "no /etc/passwd"],
    ["no agent user", { ...goodRootfs(), "etc/passwd": "root:x:0:0::/root:/bin/sh\n" }, "no `agent` user"],
    ["the agent user on another uid", { ...goodRootfs(), "etc/passwd": "agent:x:1000:1000::/home/agent:/bin/bash\n" }, "uid and gid 10001"],
    ["no home", without("home/agent/.profile"), "no /home/agent"],
    ["no git", without("usr/bin/git"), "no git"],
    ["no CA certificates", without("etc/ssl/certs/ca-certificates.crt"), "no CA certificates"],
    ["no glibc", without("lib/x86_64-linux-gnu/libc.so.6"), "no glibc"],
  ])("%s", (_what, files, expected) => {
    expect(rootfsProblems(rootfs(files)).join("; ")).toContain(expected);
  });

  test("an arm64 layout of glibc and a bundle at another path pass too", () => {
    const files = { ...without("lib/x86_64-linux-gnu/libc.so.6"), "usr/lib/aarch64-linux-gnu/libc.so.6": "glibc\n" };
    expect(rootfsProblems(rootfs(files))).toEqual([]);
  });
});

describe("ensure: fetch by digest", () => {
  test("a missing image is pulled, checked, unpacked and listed; a second ask does nothing", async () => {
    const { store, runner, refs } = setup();
    const { image, digest } = refs[0]!;
    expect(store.has(digest)).toBe(false);
    const m = await store.ensure(image, digest);
    expect(m).toMatchObject({ digest, image });
    expect(m.bytes).toBeGreaterThan(0);
    expect(store.has(digest)).toBe(true);
    expect(store.digests()).toEqual([digest]);
    expect(readFileSync(join(store.rootfsOf(digest), "etc", "passwd"), "utf8")).toContain("agent:x:10001");
    expect(runner.calls).toEqual([`pull ${image}`, "unpack"]);
    await store.ensure(image, digest);
    expect(runner.calls).toHaveLength(2);
    // The spool is empty afterwards, and nothing unfinished is left beside the image.
    expect(existsSync(join(store.dir, "spool")) ? readdirSync(join(store.dir, "spool")) : []).toEqual([]);
    expect(readdirSync(join(store.dir, "images"))).toEqual([digest.slice(7)]);
  });

  test("two asks at once make one fetch", async () => {
    const { store, runner, refs } = setup({ delayMs: 30 });
    const { image, digest } = refs[0]!;
    await Promise.all([store.ensure(image, digest), store.ensure(image, digest), store.ensure(image, digest)]);
    expect(runner.calls.filter((c) => c.startsWith("pull"))).toHaveLength(1);
  });

  test("digest mismatch: the registry answers with another image than the one pinned, and it is refused", async () => {
    const { store, refs, registry } = setup({ images: [goodRootfs(), goodRootfs({ "usr/bin/ruby": "ruby\n" })] });
    // The pinned reference now serves the other image's layout.
    registry[refs[0]!.image] = registry[refs[1]!.image]!;
    const e = await fails(store.ensure(refs[0]!.image, refs[0]!.digest));
    expect(e.message).toContain("not the pinned");
    expect(e.transient).toBe(false);
    expect(store.has(refs[0]!.digest)).toBe(false);
    expect(store.list()).toEqual([]);
  });

  test("an image that fails the checks is never listed as present, and the message says what is missing", async () => {
    const { store, refs } = setup({ images: [{ "etc/passwd": "root:x:0:0::/root:/bin/sh\n" }] });
    const e = await fails(store.ensure(refs[0]!.image, refs[0]!.digest));
    expect(e.message).toContain("cannot be used as a box");
    expect(e.message).toContain("no `agent` user");
    expect(store.has(refs[0]!.digest)).toBe(false);
    expect(readdirSync(join(store.dir, "images"))).toEqual([]);
  });

  test("a registry that does not hold the image: a transient failure, nothing cached", async () => {
    const { store } = setup();
    const digest = `sha256:${"c".repeat(64)}`;
    const e = await fails(store.ensure(`${REPO}@${digest}`, digest));
    expect(e.message).toContain("could not be fetched");
    expect(e.transient).toBe(true);
  });

  test("a pull past its deadline is aborted and reported as such", async () => {
    const { store, refs } = setup({ delayMs: 500 });
    const e = await fails(store.ensure(refs[0]!.image, refs[0]!.digest, { deadlineMs: 20 }));
    expect(e.message).toContain("was not fetched within");
    expect(e.transient).toBe(true);
    expect(store.has(refs[0]!.digest)).toBe(false);
  });

  test("a reference that does not name the pinned digest, a malformed digest and a stand-in are refused before any fetch", async () => {
    const { store, runner, refs } = setup();
    const other = `sha256:${"d".repeat(64)}`;
    expect((await fails(store.ensure(refs[0]!.image, other))).message).toContain("does not name the pinned digest");
    expect((await fails(store.ensure(`${REPO}:latest`, "latest"))).message).toContain("not sha256");
    const standIn = standInDigestFor("ab".repeat(32));
    expect((await fails(store.ensure(`${REPO}@${standIn}`, standIn))).message).toContain("stand-in");
    expect(runner.calls).toEqual([]);
  });

  test("a failure becomes BOX_IMAGE_UNAVAILABLE for the turn, with text a person can act on", async () => {
    const { store } = setup();
    const digest = `sha256:${"c".repeat(64)}`;
    const f = imageBootFailure(await fails(store.ensure(`${REPO}@${digest}`, digest)));
    expect(f).toBeInstanceOf(BootFailure);
    expect(f.code).toBe("BOX_IMAGE_UNAVAILABLE");
    expect(f.transient).toBe(true);
    expect(failureText("BOX_IMAGE_UNAVAILABLE")).toContain("/box refresh");
    expect(failureText("BOX_IMAGE_UNAVAILABLE")).toContain("won't run without it");
  });
});

describe("eviction", () => {
  const three = () => setup({ images: [goodRootfs({ f: "a".repeat(400_000) }), goodRootfs({ f: "b".repeat(400_000) }), goodRootfs({ f: "c".repeat(400_000) })], budgetMb: 1 });

  test("least recently used first, only until the cache fits, never a digest in use", async () => {
    const { store, refs, clock } = three();
    for (const [i, r] of refs.entries()) {
      clock.now = 1000 + i;
      await store.ensure(r.image, r.digest);
    }
    // The oldest is in use: it stays, and the next oldest goes.
    expect(store.evict(new Set([refs[0]!.digest]))).toEqual([refs[1]!.digest]);
    expect(store.digests().sort()).toEqual([refs[0]!.digest, refs[2]!.digest].sort());
  });

  test("using an image makes it the newest", async () => {
    const { store, refs, clock } = three();
    for (const [i, r] of refs.entries()) {
      clock.now = 1000 + i;
      await store.ensure(r.image, r.digest);
    }
    clock.now = 5000;
    store.touch(refs[0]!.digest);
    // Without the touch the first image would be the one to go.
    expect(store.evict(new Set())).toEqual([refs[1]!.digest]);
    expect(store.digests().sort()).toEqual([refs[0]!.digest, refs[2]!.digest].sort());
  });

  test("everything in use: nothing is removed, though the cache stays above its budget", async () => {
    const { store, refs } = three();
    for (const r of refs) await store.ensure(r.image, r.digest);
    expect(store.evict(new Set(refs.map((r) => r.digest)))).toEqual([]);
    expect(store.bytes()).toBeGreaterThan(1024 * 1024);
  });

  test("under the budget, or with no budget, nothing is removed", async () => {
    const big = setup({ images: [goodRootfs()], budgetMb: 100 });
    await big.store.ensure(big.refs[0]!.image, big.refs[0]!.digest);
    expect(big.store.evict(new Set())).toEqual([]);
    const none = setup({ images: [goodRootfs({ f: "a".repeat(2_000_000) })], budgetMb: 0 });
    await none.store.ensure(none.refs[0]!.image, none.refs[0]!.digest);
    expect(none.store.evict(new Set())).toEqual([]);
  });
});

describe("offline import and leftovers", () => {
  test("import loads a layout from disk without the registry, and leaves the layout where it was", async () => {
    const { store, runner } = setup();
    const layout = tmp("layout");
    const digest = writeOciLayout(layout, goodRootfs({ "usr/bin/ruby": "ruby\n" }));
    const m = await store.importLayout(layout);
    expect(m.digest).toBe(digest);
    expect(store.has(digest)).toBe(true);
    expect(runner.calls).toEqual(["unpack"]);
    expect(existsSync(join(layout, "index.json"))).toBe(true);
    // Again: already there.
    await store.importLayout(layout);
    expect(runner.calls).toEqual(["unpack"]);
  });

  test("import applies the same checks as a pull", async () => {
    const { store } = setup();
    const layout = tmp("layout");
    writeOciLayout(layout, { "etc/passwd": "root:x:0:0::/root:/bin/sh\n" });
    expect((await fails(store.importLayout(layout))).message).toContain("cannot be used as a box");
  });

  test("sweep removes what a process that died mid-fetch left, and keeps finished images", async () => {
    const { store, refs } = setup();
    await store.ensure(refs[0]!.image, refs[0]!.digest);
    mkdirSync(join(store.dir, "spool", "half"), { recursive: true });
    mkdirSync(join(store.dir, "images", ".incoming-abc"), { recursive: true });
    mkdirSync(join(store.dir, "images", "e".repeat(64), "rootfs"), { recursive: true });
    store.sweep();
    expect(existsSync(join(store.dir, "spool"))).toBe(false);
    expect(readdirSync(join(store.dir, "images"))).toEqual([refs[0]!.digest.slice(7)]);
    expect(store.remove(refs[0]!.digest)).toBe(true);
    expect(store.remove(refs[0]!.digest)).toBe(false);
  });

  test("treeBytes counts files and does not follow anything out of the tree", () => {
    const d = tmp("tree");
    writeFileSync(join(d, "a"), "12345");
    mkdirSync(join(d, "sub"));
    writeFileSync(join(d, "sub", "b"), "123");
    expect(treeBytes(d)).toBe(8);
    expect(treeBytes(join(d, "nope"))).toBe(0);
  });
});

describe("a fake registry: a layout served over HTTP", () => {
  test("pull over HTTP, then a registry that serves different bytes for the same reference", async () => {
    const good = tmp("layout");
    const digest = writeOciLayout(good, goodRootfs({ "usr/bin/ruby": "ruby\n" }));
    const evil = tmp("layout");
    writeOciLayout(evil, goodRootfs({ "usr/bin/ruby": "not what was reviewed\n" }));
    let serving = layoutFiles(good);
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = decodeURIComponent(new URL(req.url).pathname).replace(/^\/layout\//, "");
        if (path === "__list") return Response.json([...serving.keys()]);
        const body = serving.get(path);
        return body ? new Response(body) : new Response("not found", { status: 404 });
      },
    });
    try {
      const base = `http://127.0.0.1:${server.port}/layout`;
      // A runner that fetches the layout file by file: the shape of a registry client, without one.
      const http: ImageRunner = {
        async pull(_image, layoutDir, { signal }) {
          const names = (await (await fetch(`${base}/__list`, { signal })).json()) as string[];
          for (const n of names) {
            const res = await fetch(`${base}/${n}`, { signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            mkdirSync(dirname(join(layoutDir, n)), { recursive: true });
            writeFileSync(join(layoutDir, n), Buffer.from(await res.arrayBuffer()));
          }
        },
        async unpack(layoutDir, rootfsDir) {
          unpackTestLayout(layoutDir, rootfsDir);
        },
      };
      const store = makeImageStore({ dir: tmp("boxdir"), runner: http, budgetMb: 0, log: () => {} });
      await store.ensure(`${REPO}@${digest}`, digest);
      expect(readFileSync(join(store.rootfsOf(digest), "usr", "bin", "ruby"), "utf8")).toBe("ruby\n");

      // A second node, and the registry now answers the same reference with other content.
      serving = layoutFiles(evil);
      const second = makeImageStore({ dir: tmp("boxdir"), runner: http, budgetMb: 0, log: () => {} });
      const e = await fails(second.ensure(`${REPO}@${digest}`, digest));
      expect(e.message).toContain("not the pinned");
      expect(second.has(digest)).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});

describe("the skopeo and umoci runner (argv only; the tools are not run here)", () => {
  test("pull copies by digest, keeps the manifest as it is, and passes the credential by flag, never in the reference", async () => {
    const calls: string[][] = [];
    const r = cliImageRunner(async (argv) => (calls.push(argv), { code: 0, stderr: "" }));
    await r.pull(`${REPO}@sha256:${"a".repeat(64)}`, "/spool/x", { auth: "user:pass-not-logged" });
    expect(calls[0]).toEqual(["skopeo", "copy", "--preserve-digests", "--quiet", "--src-creds", "user:pass-not-logged", `docker://${REPO}@sha256:${"a".repeat(64)}`, "oci:/spool/x:box"]);
    await r.pull(`${REPO}@sha256:${"a".repeat(64)}`, "/spool/y", {});
    expect(calls[1]).toContain("--src-no-creds");
    expect(calls[1]!.join(" ")).not.toContain("--src-creds");
  });

  test("a failed pull reports the tool's last line with credentials taken out", async () => {
    const r = cliImageRunner(async () => ({ code: 1, stderr: "trying\nerror: GET https://user:hunter2@registry.example.com/v2/: Bearer abc.def denied\n" }));
    const e = await fails(r.pull(`${REPO}@sha256:${"a".repeat(64)}`, "/spool/x", { auth: "user:hunter2" }));
    expect(e.message).toContain("skopeo copy failed (exit 1)");
    expect(e.message).not.toContain("hunter2");
    expect(e.message).not.toContain("abc.def");
  });

  test("unpack names the image by the layout's tag and refuses a layout without one", async () => {
    const layout = tmp("layout");
    writeOciLayout(layout);
    const calls: string[][] = [];
    const rootfs = join(tmp("out"), "rootfs");
    const r = cliImageRunner(async (argv) => {
      calls.push(argv);
      mkdirSync(join(argv.at(-1)!, "rootfs"), { recursive: true });
      return { code: 0, stderr: "" };
    });
    await r.unpack(layout, rootfs, {});
    expect(calls[0]).toEqual(["umoci", "unpack", "--rootless", "--image", `${layout}:box`, `${rootfs}.bundle`]);
    expect(existsSync(rootfs)).toBe(true);
    expect(existsSync(`${rootfs}.bundle`)).toBe(false);
    const untagged = tmp("layout");
    writeOciLayout(untagged, goodRootfs(), { tag: null });
    expect((await fails(r.unpack(untagged, join(tmp("out"), "rootfs"), {}))).message).toContain("has no tag");
  });
});
