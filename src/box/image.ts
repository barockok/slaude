/**
 * A node's cache of box images (box spec, "Image build, pull and prewarm").
 *
 * An image is always named by digest. The node worker downloads it into the
 * spool as an OCI layout, the layout's manifest is checked against the pinned
 * digest here (never trusted from the tool that fetched it), it is unpacked to
 * `images/<hex>/rootfs`, and the unpacked tree is checked for what a box needs
 * before the image is ever listed as present.
 *
 * The two external tools are behind {@link ImageRunner} (v1: `skopeo copy`
 * and `umoci unpack`), so a native registry client can replace them and tests
 * run with a fake. Nothing here builds an image: builds run in CI only.
 *
 * Layout under the box directory (SLAUDE_BOX_DIR):
 *
 *   images/<hex>/rootfs      the unpacked image, read-only for every sandbox
 *   images/<hex>/image.json  { digest, image, bytes, pulledAt, lastUsed }
 *   spool/<hex>.<random>/    an OCI layout being fetched; removed afterwards
 *
 * An image directory appears by one rename of a finished directory, so a
 * crash never leaves a half image that reads as present.
 *
 * Eviction: least recently used first, only above the budget, never a digest
 * the caller says is in use (current for a label, or pinned by a session warm
 * or parked on this node).
 */
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BootFailure } from "../gateway/core/failure-codes";
import { isStandInImage } from "./definition";

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const IMAGE_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-]+[a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/;

/** The uid and gid every box image must give its `agent` user. */
export const BOX_AGENT_UID = 10001;

/** The tools that fetch and unpack. Replaceable; never given a shell string. */
export interface ImageRunner {
  /**
   * Fetch `image` (`<repository>@sha256:<digest>`) into `layoutDir` as an OCI
   * image layout, keeping the manifest byte for byte (its digest is checked
   * afterwards). `auth` is the node's optional registry credential.
   */
  pull(image: string, layoutDir: string, o: { auth?: string; signal?: AbortSignal }): Promise<void>;
  /** Unpack the layout's one image into `rootfsDir`. */
  unpack(layoutDir: string, rootfsDir: string, o: { signal?: AbortSignal }): Promise<void>;
}

/** An image could not be made present. The message names digests and steps, never a credential. */
export class BoxImageError extends Error {
  override readonly name = "BoxImageError";
  constructor(
    message: string,
    /** True when trying again may work (a network failure, a timeout). */
    readonly transient: boolean,
  ) {
    super(message);
  }
}

/** The failure a session boot reports when its image cannot be made present. */
export const imageBootFailure = (e: unknown): BootFailure =>
  e instanceof BootFailure
    ? e
    : new BootFailure("BOX_IMAGE_UNAVAILABLE", e instanceof Error ? e.message : String(e), { cause: e, transient: e instanceof BoxImageError ? e.transient : true });

export interface CachedImage {
  digest: string;
  image: string;
  /** Unpacked size on disk, measured once after the unpack. */
  bytes: number;
  pulledAt: number;
  lastUsed: number;
}

const hexOf = (digest: string): string => digest.slice("sha256:".length);
const short = (digest: string): string => hexOf(digest).slice(0, 12);

function assertDigest(digest: string): void {
  if (!DIGEST_RE.test(digest)) throw new BoxImageError("the image digest is not sha256:<64 hex digits>", false);
  if (isStandInImage(digest)) throw new BoxImageError("the image digest is a stand-in for an image that was never pushed", false);
}

/** Bytes of a tree, not following symlinks. */
export function treeBytes(root: string): number {
  let total = 0;
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else total += st.size;
    }
  };
  if (existsSync(root)) walk(root);
  return total;
}

/**
 * The digest of the one image in an OCI layout, checked two ways: the index
 * names it, and the manifest blob hashes to it. Throws when the layout is not
 * a single-image layout or the blob does not match its name.
 */
export function layoutDigest(layoutDir: string): string {
  let index: { manifests?: Array<{ digest?: unknown; mediaType?: unknown }> };
  try {
    index = JSON.parse(readFileSync(join(layoutDir, "index.json"), "utf8")) as typeof index;
  } catch {
    throw new BoxImageError("the fetched image is not an OCI layout (index.json is missing or unreadable)", false);
  }
  const manifests = Array.isArray(index.manifests) ? index.manifests : [];
  if (manifests.length !== 1) throw new BoxImageError(`the fetched layout holds ${manifests.length} images; exactly one is expected`, false);
  const digest = manifests[0]!.digest;
  if (typeof digest !== "string" || !DIGEST_RE.test(digest)) throw new BoxImageError("the fetched layout's index names no sha256 digest", false);
  const blob = join(layoutDir, "blobs", "sha256", hexOf(digest));
  if (!existsSync(blob)) throw new BoxImageError("the fetched layout does not hold the manifest its index names", false);
  const actual = `sha256:${createHash("sha256").update(readFileSync(blob)).digest("hex")}`;
  if (actual !== digest) throw new BoxImageError("the fetched manifest does not hash to the digest it is stored under", false);
  return digest;
}

/**
 * What a box needs of an image, checked on the unpacked tree. Returns one
 * sentence per problem; an empty list passes. Kept small on purpose: these are
 * the things without which no session can start, not a review of the image.
 */
export function rootfsProblems(rootfs: string): string[] {
  const problems: string[] = [];
  const has = (...rel: string[]) => rel.some((r) => existsSync(join(rootfs, r)));
  let passwd = "";
  try {
    passwd = readFileSync(join(rootfs, "etc", "passwd"), "utf8");
  } catch {
    problems.push("the image has no /etc/passwd");
  }
  if (passwd) {
    const agent = passwd.split("\n").map((l) => l.split(":")).find((f) => f[0] === "agent");
    if (!agent) problems.push("the image has no `agent` user");
    else if (Number(agent[2]) !== BOX_AGENT_UID || Number(agent[3]) !== BOX_AGENT_UID) problems.push(`the image's agent user must have uid and gid ${BOX_AGENT_UID}`);
  }
  if (!has("home/agent")) problems.push("the image has no /home/agent");
  if (!has("usr/bin/git", "bin/git", "usr/local/bin/git")) problems.push("the image has no git");
  if (!has("etc/ssl/certs/ca-certificates.crt", "etc/pki/tls/certs/ca-bundle.crt", "etc/ssl/cert.pem")) problems.push("the image has no CA certificates");
  if (!has("lib/x86_64-linux-gnu/libc.so.6", "lib/aarch64-linux-gnu/libc.so.6", "lib64/libc.so.6", "usr/lib/x86_64-linux-gnu/libc.so.6", "usr/lib/aarch64-linux-gnu/libc.so.6", "usr/lib64/libc.so.6", "usr/lib/libc.so.6")) {
    problems.push("the image has no glibc (a musl image cannot run the agent's CLI)");
  }
  return problems;
}

export interface ImageStoreOpts {
  /** SLAUDE_BOX_DIR. */
  dir: string;
  runner: ImageRunner;
  /** SLAUDE_BOX_IMAGE_BUDGET_MB. 0: no eviction. */
  budgetMb: number;
  /** The node's optional registry credential (SLAUDE_BOX_REGISTRY_AUTH). Never logged, never given to a box. */
  auth?: string;
  now?: () => number;
  /** TEST SEAM: the image checks (default {@link rootfsProblems}). */
  problems?: (rootfs: string) => string[];
  log?: (line: string) => void;
}

export type ImageStore = ReturnType<typeof makeImageStore>;

export function makeImageStore(o: ImageStoreOpts) {
  const now = o.now ?? Date.now;
  const log = o.log ?? ((l: string) => console.log(l));
  const problems = o.problems ?? rootfsProblems;
  const imagesDir = join(o.dir, "images");
  const spoolDir = join(o.dir, "spool");
  const dirOf = (digest: string) => join(imagesDir, hexOf(digest));
  const metaOf = (digest: string) => join(dirOf(digest), "image.json");
  /** One fetch per digest at a time: a second caller waits for the first. */
  const inflight = new Map<string, Promise<CachedImage>>();

  function read(digest: string): CachedImage | null {
    try {
      const m = JSON.parse(readFileSync(metaOf(digest), "utf8")) as Partial<CachedImage>;
      if (m.digest !== digest || typeof m.image !== "string" || !existsSync(join(dirOf(digest), "rootfs"))) return null;
      return { digest, image: m.image, bytes: Number(m.bytes) || 0, pulledAt: Number(m.pulledAt) || 0, lastUsed: Number(m.lastUsed) || 0 };
    } catch {
      return null;
    }
  }

  function write(m: CachedImage, dir = dirOf(m.digest)): void {
    const tmp = join(dir, `image.json.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(m));
    renameSync(tmp, join(dir, "image.json"));
  }

  function list(): CachedImage[] {
    if (!existsSync(imagesDir)) return [];
    const out: CachedImage[] = [];
    for (const name of readdirSync(imagesDir)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      const m = read(`sha256:${name}`);
      if (m) out.push(m);
    }
    return out.sort((a, b) => (a.digest < b.digest ? -1 : 1));
  }

  /** Turn a verified OCI layout into a present image. The layout is consumed. */
  async function install(layout: string, image: string, digest: string, signal?: AbortSignal): Promise<CachedImage> {
    const got = layoutDigest(layout);
    if (got !== digest) throw new BoxImageError(`the fetched image is ${short(got)}, not the pinned ${short(digest)}: refused`, false);
    const staging = join(imagesDir, `.incoming-${hexOf(digest).slice(0, 16)}-${randomBytes(4).toString("hex")}`);
    mkdirSync(staging, { recursive: true });
    try {
      await o.runner.unpack(layout, join(staging, "rootfs"), { signal }).catch((e: unknown) => {
        throw e instanceof BoxImageError ? e : new BoxImageError(`the image ${short(digest)} could not be unpacked: ${e instanceof Error ? e.message : String(e)}`, false);
      });
      if (!existsSync(join(staging, "rootfs"))) throw new BoxImageError(`unpacking the image ${short(digest)} produced no root filesystem`, false);
      const found = problems(join(staging, "rootfs"));
      if (found.length) throw new BoxImageError(`the image ${short(digest)} cannot be used as a box: ${found.join("; ")}`, false);
      const at = now();
      const meta: CachedImage = { digest, image, bytes: treeBytes(join(staging, "rootfs")), pulledAt: at, lastUsed: at };
      write(meta, staging);
      // Another process of this node finished first: its copy stands.
      if (read(digest)) {
        rmSync(staging, { recursive: true, force: true });
        return read(digest)!;
      }
      rmSync(dirOf(digest), { recursive: true, force: true });
      renameSync(staging, dirOf(digest));
      return meta;
    } catch (e) {
      rmSync(staging, { recursive: true, force: true });
      throw e;
    }
  }

  async function fetch(image: string, digest: string, deadlineMs: number | undefined): Promise<CachedImage> {
    mkdirSync(spoolDir, { recursive: true });
    const layout = join(spoolDir, `${hexOf(digest).slice(0, 16)}.${randomBytes(4).toString("hex")}`);
    const ac = new AbortController();
    let timedOut = false;
    const timer = deadlineMs === undefined ? null : setTimeout(() => ((timedOut = true), ac.abort()), Math.max(1, deadlineMs));
    try {
      await o.runner.pull(image, layout, { ...(o.auth ? { auth: o.auth } : {}), signal: ac.signal }).catch((e: unknown) => {
        if (timedOut) throw new BoxImageError(`the image ${short(digest)} was not fetched within ${Math.round(deadlineMs! / 1000)} s`, true);
        throw e instanceof BoxImageError ? e : new BoxImageError(`the image ${short(digest)} could not be fetched: ${e instanceof Error ? e.message : String(e)}`, true);
      });
      if (timedOut) throw new BoxImageError(`the image ${short(digest)} was not fetched within ${Math.round(deadlineMs! / 1000)} s`, true);
      const meta = await install(layout, image, digest, ac.signal);
      log(`[box] image ${short(digest)} is present (${Math.round(meta.bytes / (1024 * 1024))} MB unpacked)`);
      return meta;
    } finally {
      if (timer) clearTimeout(timer);
      rmSync(layout, { recursive: true, force: true });
    }
  }

  return {
    dir: o.dir,

    /** The root filesystem a sandbox of this digest is built on. */
    rootfsOf: (digest: string): string => join(dirOf(digest), "rootfs"),

    has(digest: string): boolean {
      return DIGEST_RE.test(digest) && read(digest) !== null;
    },

    list,

    /** The digests present, sorted: what the heartbeat reports. */
    digests(): string[] {
      return list().map((m) => m.digest);
    },

    /**
     * Make an image present: nothing when it already is, a fetch (under
     * `deadlineMs`) otherwise. Marks it used. Throws {@link BoxImageError}.
     */
    async ensure(image: string, digest: string, opts: { deadlineMs?: number } = {}): Promise<CachedImage> {
      assertDigest(digest);
      if (!IMAGE_RE.test(image) || !image.endsWith(`@${digest}`)) throw new BoxImageError("the image reference does not name the pinned digest", false);
      const have = read(digest);
      if (have) {
        have.lastUsed = now();
        write(have);
        return have;
      }
      let p = inflight.get(digest);
      if (!p) {
        p = fetch(image, digest, opts.deadlineMs).finally(() => inflight.delete(digest));
        inflight.set(digest, p);
      }
      return p;
    },

    /** A session started on this image: it is the most recently used. */
    touch(digest: string): void {
      const have = DIGEST_RE.test(digest) ? read(digest) : null;
      if (!have) return;
      have.lastUsed = now();
      write(have);
    },

    /**
     * Offline: load an image from an OCI layout directory on disk (`slaude box
     * import`). The layout is copied, never moved. `image` names where it came
     * from; default a local name. Returns the cached image.
     */
    async importLayout(layoutDir: string, image?: string): Promise<CachedImage> {
      const digest = layoutDigest(layoutDir);
      assertDigest(digest);
      const have = read(digest);
      if (have) return have;
      mkdirSync(spoolDir, { recursive: true });
      const copy = join(spoolDir, `${hexOf(digest).slice(0, 16)}.import-${randomBytes(4).toString("hex")}`);
      cpSync(layoutDir, copy, { recursive: true });
      try {
        return await install(copy, image ?? `localhost/imported@${digest}`, digest);
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    },

    remove(digest: string): boolean {
      if (!DIGEST_RE.test(digest) || !existsSync(dirOf(digest))) return false;
      rmSync(dirOf(digest), { recursive: true, force: true });
      return true;
    },

    /**
     * Drop least recently used images until the cache fits the budget. Never
     * one in `inUse`. Returns what was removed, oldest first. With every
     * remaining image in use the cache may stay above the budget: that is
     * reported by the caller's gauge, not fixed by removing a running image.
     */
    evict(inUse: ReadonlySet<string>): string[] {
      if (o.budgetMb <= 0) return [];
      const budget = o.budgetMb * 1024 * 1024;
      const all = list();
      let total = all.reduce((n, m) => n + m.bytes, 0);
      const removed: string[] = [];
      for (const m of all.filter((x) => !inUse.has(x.digest)).sort((a, b) => a.lastUsed - b.lastUsed || (a.digest < b.digest ? -1 : 1))) {
        if (total <= budget) break;
        rmSync(dirOf(m.digest), { recursive: true, force: true });
        total -= m.bytes;
        removed.push(m.digest);
        log(`[box] image ${short(m.digest)} evicted (least recently used, cache above ${o.budgetMb} MB)`);
      }
      return removed;
    },

    /** Unpacked bytes of every image present. */
    bytes(): number {
      return list().reduce((n, m) => n + m.bytes, 0);
    },

    /** Leftovers of a process that died mid-fetch: the spool and unfinished image directories. */
    sweep(): void {
      rmSync(spoolDir, { recursive: true, force: true });
      if (!existsSync(imagesDir)) return;
      for (const name of readdirSync(imagesDir)) {
        const p = join(imagesDir, name);
        if (name.startsWith(".incoming-") || (statSync(p).isDirectory() && /^[a-f0-9]{64}$/.test(name) && !read(`sha256:${name}`))) rmSync(p, { recursive: true, force: true });
      }
    },
  };
}

/** Run a command, capturing its output. Never passed a shell string. */
async function run(argv: string[], signal?: AbortSignal): Promise<{ code: number; stderr: string }> {
  const p = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe", stdin: "ignore", ...(signal ? { signal } : {}) });
  const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  return { code, stderr };
}

/** The last line of a tool's stderr, with anything shaped like a credential or a URL's userinfo taken out. */
function lastLine(stderr: string): string {
  const line = stderr.trim().split("\n").at(-1) ?? "";
  return line.replace(/\/\/[^/@\s]+@/g, "//").replace(/(?:Bearer|Basic)\s+\S+/gi, "[credential]").slice(0, 300);
}

/**
 * The v1 runner: `skopeo copy` by digest into an OCI layout, and `umoci
 * unpack` (rootless) of that layout. NOT RUN in this repository's tests or on
 * the machine this was written on: the argv below is what the two tools
 * document, exercised only through a fake `exec`. `--preserve-digests` makes
 * skopeo refuse to rewrite the manifest, so the digest check that follows
 * compares like with like.
 */
export function cliImageRunner(exec: typeof run = run): ImageRunner {
  return {
    async pull(image, layoutDir, { auth, signal }) {
      // The credential goes to skopeo through its own flag, never into the image reference or a log line.
      const argv = ["skopeo", "copy", "--preserve-digests", "--quiet", ...(auth ? ["--src-creds", auth] : ["--src-no-creds"]), `docker://${image}`, `oci:${layoutDir}:box`];
      const r = await exec(argv, signal);
      if (r.code !== 0) throw new BoxImageError(`skopeo copy failed (exit ${r.code}): ${lastLine(r.stderr)}`, true);
    },
    async unpack(layoutDir, rootfsDir, { signal }) {
      // umoci names an image by its tag in the layout: `box` for one this runner fetched, whatever an imported layout carries.
      let tag: unknown;
      try {
        const index = JSON.parse(readFileSync(join(layoutDir, "index.json"), "utf8")) as { manifests?: Array<{ annotations?: Record<string, unknown> }> };
        tag = index.manifests?.[0]?.annotations?.["org.opencontainers.image.ref.name"];
      } catch {
        tag = undefined;
      }
      if (typeof tag !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag)) {
        throw new BoxImageError("the layout's image has no tag (org.opencontainers.image.ref.name), which umoci needs to unpack it", false);
      }
      // umoci writes a bundle (config.json plus rootfs); only the rootfs is kept.
      const bundle = `${rootfsDir}.bundle`;
      const r = await exec(["umoci", "unpack", "--rootless", "--image", `${layoutDir}:${tag}`, bundle], signal);
      try {
        if (r.code !== 0) throw new BoxImageError(`umoci unpack failed (exit ${r.code}): ${lastLine(r.stderr)}`, false);
        renameSync(join(bundle, "rootfs"), rootfsDir);
      } finally {
        rmSync(bundle, { recursive: true, force: true });
      }
    },
  };
}
