/**
 * The box step of `slaude personas render` and `slaude box check` (box spec,
 * "How it compiles").
 *
 *   1. Parse and validate every `boxes/<name>/box.yaml`.
 *   2. `image.ref`: use the digest as written.
 *   3. `image.build`: hash the build context (the Dockerfile and every file
 *      under `context`, sorted). If the registry already holds
 *      `<registry>/<name>:ctx-<hash>`, reuse its digest. Otherwise build, push
 *      that tag and read the digest. A rebuild therefore happens only when a
 *      reviewed file changed. This is the ONLY place a build runs, and it runs
 *      in CI with CI's registry credentials; the gateway and the nodes never
 *      build.
 *   4. Emit one payload entry per box, with its defaults written out.
 *
 * The registry and the builder are behind {@link ImageResolver}, so tests run
 * the step with a fake and nothing here needs docker to be type-checked.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { BOX_IMAGE_REF_RE, BOX_NAME_RE, BOX_STAND_IN_REGISTRY, parseBoxYaml, standInDigestFor, toBoxPayload, type BoxPayloadEntry, type ParsedBoxFile } from "../box/definition";
import { PayloadError } from "../persona/sync/errors";

export const BOX_YAML = "box.yaml";
/** `<registry>/<repository prefix>` that built box images are pushed under, for example ghcr.io/example/boxes. */
export const BOX_REGISTRY_ENV = "SLAUDE_BOX_REGISTRY";
const REGISTRY_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-]+[a-z0-9]+)*)*$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
/** The repository prefix of a stand-in image when no registry is configured. `.invalid` never resolves. */
const STATIC_REGISTRY = `${BOX_STAND_IN_REGISTRY}/boxes`;

export interface BoxDirEntry {
  /** The absolute box directory. */
  dir: string;
  file: ParsedBoxFile;
}

/** Every `boxes/<name>/box.yaml` of a deploy repository, parsed and so vetted. A folder that exists (even empty) is the whole set. */
export function readBoxDir(dir: string): BoxDirEntry[] {
  const out: BoxDirEntry[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const label = BOX_NAME_RE.test(name) ? name : "an entry";
    const boxDir = join(dir, name);
    if (!lstatSync(boxDir).isDirectory()) throw new PayloadError(`boxes/ holds only <name>/ directories with a ${BOX_YAML}; '${label}' is not one`);
    if (!BOX_NAME_RE.test(name)) throw new PayloadError(`boxes/: a directory name is not a valid box name (${BOX_NAME_RE.source})`);
    const file = join(boxDir, BOX_YAML);
    if (!existsSync(file)) throw new PayloadError(`box '${name}': boxes/${name}/ has no ${BOX_YAML}`);
    out.push({ dir: resolve(boxDir), file: parseBoxYaml(name, readFileSync(file, "utf8")) });
  }
  return out;
}

/** The build's Dockerfile and context as absolute paths, both confined to the box directory (after symlinks). */
function buildPaths(entry: BoxDirEntry): { dockerfile: string; context: string } {
  if (!("build" in entry.file.image)) throw new Error("not a build box");
  const who = `box '${entry.file.name}'`;
  const root = realpathSync(entry.dir);
  const inside = (p: string, what: string) => {
    if (!existsSync(p)) throw new PayloadError(`${who}: image.build.${what} does not exist in the box directory`);
    const real = realpathSync(p);
    if (real !== root && !real.startsWith(root + sep)) throw new PayloadError(`${who}: image.build.${what} leaves the box directory`);
    return real;
  };
  const context = inside(join(entry.dir, entry.file.image.build.context), "context");
  const dockerfile = inside(join(entry.dir, entry.file.image.build.dockerfile), "dockerfile");
  if (!lstatSync(context).isDirectory()) throw new PayloadError(`${who}: image.build.context is not a directory`);
  if (!lstatSync(dockerfile).isFile()) throw new PayloadError(`${who}: image.build.dockerfile is not a file`);
  return { dockerfile, context };
}

/**
 * The hash of a build: the Dockerfile and every file under the context, by
 * sorted relative path, with each file's mode bit for "executable". A symlink
 * is hashed as its target text and never followed. box.yaml itself is left out
 * when it sits in the context: a policy change is not an image change.
 */
export function contextHash(entry: BoxDirEntry): string {
  const { dockerfile, context } = buildPaths(entry);
  const h = createHash("sha256");
  const add = (label: string, kind: string, body: Buffer | string) => {
    h.update(`${label}\0${kind}\0`);
    h.update(body);
    h.update("\0");
  };
  add("dockerfile", "file", readFileSync(dockerfile));
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const rel = relative(context, p).split(sep).join("/");
      const st = lstatSync(p);
      if (st.isSymbolicLink()) add(rel, "link", readlinkSync(p));
      else if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        if (p === join(realpathSync(entry.dir), BOX_YAML)) continue;
        add(rel, st.mode & 0o111 ? "exec" : "file", readFileSync(p));
      }
    }
  };
  walk(context);
  return h.digest("hex");
}

export interface ImageResolver {
  /** The digest (`sha256:...`) of `<repository>:<tag>` in the registry, or null when the registry does not hold it. */
  lookup(repository: string, tag: string): Promise<string | null>;
  /** Build the image; with `push`, push `<repository>:<tag>` and return its digest. Without `push` it proves the build and returns null. */
  build(o: { dockerfile: string; context: string; repository: string; tag: string; push: boolean }): Promise<string | null>;
}

export interface CompileBoxOpts {
  /** Not used in `static` mode. */
  resolver?: ImageResolver;
  /** `<registry>/<prefix>` built images live under ({@link BOX_REGISTRY_ENV}). Needed when a box uses image.build, except in `static` mode. */
  registry?: string;
  /**
   * `push` (the main branch): build and push what the registry lacks.
   * `check` (a pull request): build without pushing, to prove the Dockerfile
   * builds; the entry then carries a stand-in digest (see {@link standInDigest}).
   * `static`: no registry and no build at all; every image.build entry carries
   * a stand-in digest. For `personas render --check`, which prints no payload.
   */
  mode: "push" | "check" | "static";
  log?: (line: string) => void;
}

/**
 * The digest a `check` run reports for an image that is not in the registry
 * yet. It is derived from the context hash, names no real image, and exists so
 * the gateway's dry run can print "image: new digest" on a pull request. A
 * payload that carries one must never be deployed: no registry holds it. The
 * digest is marked (src/box/definition.ts, isStandInImage), so the gateway
 * refuses a real sync that carries one and a node refuses to boot on one.
 */
export function standInDigest(hash: string): string {
  return standInDigestFor(hash);
}

export interface CompiledBoxes {
  boxes: BoxPayloadEntry[];
  /** Names of boxes whose entry carries a stand-in digest (`check` mode only). */
  unpushed: string[];
}

/** Compile every box of `boxes/` to its payload entry, resolving each image to a digest. */
export async function compileBoxes(boxesDir: string, o: CompileBoxOpts): Promise<CompiledBoxes> {
  const entries = readBoxDir(boxesDir);
  const boxes: BoxPayloadEntry[] = [];
  const unpushed: string[] = [];
  for (const e of entries) {
    const who = `box '${e.file.name}'`;
    if ("ref" in e.file.image) {
      boxes.push(toBoxPayload(e.file, e.file.image.ref));
      continue;
    }
    const registry = (o.registry ?? "").trim().replace(/\/+$/, "") || (o.mode === "static" ? STATIC_REGISTRY : "");
    if (!registry) throw new PayloadError(`${who}: image.build needs ${BOX_REGISTRY_ENV} (the registry and repository prefix built images are pushed under), or write image.ref`);
    if (!REGISTRY_RE.test(registry)) throw new PayloadError(`${who}: ${BOX_REGISTRY_ENV} must be <registry>/<repository prefix> in lower case, with no scheme, tag or credentials`);
    const { dockerfile, context } = buildPaths(e);
    const hash = contextHash(e);
    const repository = `${registry}/${e.file.name}`;
    const tag = `ctx-${hash.slice(0, 32)}`;
    if (o.mode === "static") {
      unpushed.push(e.file.name);
      boxes.push(toBoxPayload(e.file, `${repository}@${standInDigest(hash)}`));
      continue;
    }
    if (!o.resolver) throw new Error("compileBoxes needs a resolver outside static mode");
    let digest = await o.resolver.lookup(repository, tag);
    if (digest === null) {
      o.log?.(`${who}: the registry has no image for this build context; building${o.mode === "push" ? " and pushing" : " (not pushed)"}`);
      digest = await o.resolver.build({ dockerfile, context, repository, tag, push: o.mode === "push" });
      if (digest === null) {
        if (o.mode === "push") throw new PayloadError(`${who}: the build pushed no image (no digest was reported)`);
        digest = standInDigest(hash);
        unpushed.push(e.file.name);
      }
    }
    if (!DIGEST_RE.test(digest)) throw new PayloadError(`${who}: the registry reported something that is not a sha256 digest`);
    const image = `${repository}@${digest}`;
    if (!BOX_IMAGE_REF_RE.test(image)) throw new PayloadError(`${who}: the built image reference is not a valid <registry>/<repository>@sha256:<digest>`);
    boxes.push(toBoxPayload(e.file, image));
  }
  return { boxes, unpushed };
}

/** Run a command, capturing its output. Never passed a shell string. */
async function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}

/**
 * The resolver CI uses: `docker buildx`, with whatever registry login the
 * pipeline already did. `exec` is a seam for tests.
 */
export function dockerResolver(exec: typeof run = run): ImageResolver {
  return {
    async lookup(repository, tag) {
      const r = await exec(["docker", "buildx", "imagetools", "inspect", `${repository}:${tag}`, "--format", "{{json .Manifest}}"]);
      if (r.code !== 0) {
        // Absent is an answer; anything else (no login, no network) must not be read as "build it again".
        if (/not found|manifest unknown|no such manifest|name unknown/i.test(r.stderr)) return null;
        throw new PayloadError(`the registry lookup for a box image failed (exit ${r.code}); check the registry login`);
      }
      try {
        const digest = (JSON.parse(r.stdout) as { digest?: unknown }).digest;
        return typeof digest === "string" ? digest : null;
      } catch {
        throw new PayloadError("the registry lookup for a box image returned something unreadable");
      }
    },
    async build({ dockerfile, context, repository, tag, push }) {
      // Outside the context: the file must not become part of the image or of the next context hash.
      const meta = join(tmpdir(), `slaude-box-build-${process.pid}-${Date.now()}.json`);
      const argv = ["docker", "buildx", "build", "--file", dockerfile, "--tag", `${repository}:${tag}`, "--metadata-file", meta, ...(push ? ["--push"] : []), context];
      const r = await exec(argv);
      try {
        if (r.code !== 0) throw new PayloadError(`a box image failed to build (exit ${r.code}); the build log is above`);
        if (!push) return null;
        const digest = existsSync(meta) ? (JSON.parse(readFileSync(meta, "utf8")) as Record<string, unknown>)["containerimage.digest"] : undefined;
        return typeof digest === "string" ? digest : null;
      } finally {
        rmSync(meta, { force: true });
      }
    },
  };
}

export interface BoxCheckResult {
  boxes: Array<{ name: string; image: "ref" | "build"; contextHash?: string }>;
  /** What this command does not check, said plainly. */
  notChecked: string[];
}

/**
 * `slaude box check <dir>`: the schema of every box.yaml (strict keys, no
 * placeholder, no secret shape) and, for image.build, that the Dockerfile and
 * the context exist inside the box directory. `dir` is a deploy repository
 * (with a boxes/ folder) or a boxes/ folder itself.
 */
export function checkBoxes(dir: string): BoxCheckResult {
  const boxesDir = existsSync(join(dir, "boxes")) ? join(dir, "boxes") : dir;
  if (!existsSync(boxesDir) || !lstatSync(boxesDir).isDirectory()) throw new PayloadError(`no boxes/ directory in ${dir}`);
  const boxes = readBoxDir(boxesDir).map((e) =>
    "build" in e.file.image ? { name: e.file.name, image: "build" as const, contextHash: contextHash(e) } : { name: e.file.name, image: "ref" as const },
  );
  return {
    boxes,
    notChecked: [
      "the image's contents (linux, glibc, the agent user with uid and gid 10001, git, ca-certificates): a node checks them when it unpacks the image",
    ],
  };
}

const USAGE = [
  "usage: slaude box check <deploy repository or boxes directory>",
  "       slaude box from-manifest <node.json> <persona> [--workspace <server,...>]",
  "       slaude box import <oci layout directory> [--box-dir <directory>]",
  "       slaude box preflight <persona> --repo <deploy repository> [--box <name>] [--manifest <node.json>]",
  "                            [--private-code | --no-private-code] [--code-host <mcp server>]",
  "       slaude box digests --in-use",
].join("\n");

/** Ask one yes/no question on a terminal. Undefined when there is no terminal to ask. */
async function askYesNo(question: string): Promise<boolean | undefined> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return undefined;
  process.stderr.write(`${question} [y/n] `);
  for await (const chunk of process.stdin) {
    const a = String(chunk).trim().toLowerCase();
    if (a === "y" || a === "yes") return true;
    if (a === "n" || a === "no") return false;
    process.stderr.write("y or n: ");
  }
  return undefined;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const [cmd, dir] = argv;
  const valued = new Set(["--workspace", "--repo", "--box", "--manifest", "--code-host", "--box-dir"]);
  const flags = new Map<string, string>();
  const pos: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    if (valued.has(argv[i]!)) flags.set(argv[i]!, argv[++i] ?? "");
    else if (argv[i]!.startsWith("--")) flags.set(argv[i]!, "");
    else pos.push(argv[i]!);
  }
  try {
    if (cmd === "from-manifest" && pos.length === 2) {
      // Loaded here: the module imports this file's box reader.
      const { classifyManifest, renderFromManifest } = await import("./box-migrate");
      const { readDeclaredNodeManifest } = await import("../node/manifest");
      const text = readFileSync(pos[0]!, "utf8");
      const workspace = (flags.get("--workspace") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      process.stdout.write(renderFromManifest(classifyManifest(readDeclaredNodeManifest(text, pos[0]!), pos[1]!, { workspace })));
    } else if (cmd === "import" && pos.length === 1) {
      // Offline: load an image into this node's cache from an OCI layout on disk. Run on the node, as the user that owns SLAUDE_BOX_DIR.
      const { makeImageStore, cliImageRunner } = await import("../box/image");
      const boxDir = flags.get("--box-dir") || process.env.SLAUDE_BOX_DIR || "/var/lib/slaude-box";
      const store = makeImageStore({ dir: boxDir, runner: cliImageRunner(), budgetMb: 0, log: (l) => console.error(l) });
      const m = await store.importLayout(pos[0]!);
      console.log(`imported ${m.digest} (${Math.round(m.bytes / (1024 * 1024))} MB unpacked) into ${boxDir}`);
    } else if (cmd === "preflight" && pos.length === 1) {
      const { preflight, renderPreflight } = await import("./box-migrate");
      const repo = flags.get("--repo") || ".";
      let privateCode = flags.has("--private-code") ? true : flags.has("--no-private-code") ? false : undefined;
      if (flags.has("--private-code") && flags.has("--no-private-code")) throw new PayloadError("--private-code and --no-private-code cannot both be given");
      if (privateCode === undefined) privateCode = await askYesNo("Does this persona need private repositories or package registries from its shell?");
      // A live node is asked for only where this environment names a Redis; otherwise the check says it was not made.
      let close: (() => Promise<void>) | undefined;
      let liveNodes: ((label: string, cap: string) => Promise<Array<{ node: string; has: boolean }>>) | undefined;
      if (process.env.SLAUDE_REDIS_URL) {
        const { getRedis, closeRedis } = await import("../queue/redis");
        const { makeRegistry } = await import("../queue/registry");
        const registry = makeRegistry({ redis: getRedis() });
        liveNodes = (label, cap) => registry.liveNodesWithCap(label, cap);
        close = closeRedis;
      }
      try {
        const r = await preflight(pos[0]!, {
          repo,
          ...(flags.get("--manifest") ? { manifest: flags.get("--manifest")! } : {}),
          ...(flags.get("--box") ? { box: flags.get("--box")! } : {}),
          ...(flags.get("--code-host") ? { codeHost: flags.get("--code-host")! } : {}),
          ...(privateCode !== undefined ? { privateCode } : {}),
          ...(liveNodes ? { liveNodes } : {}),
        });
        process.stdout.write(renderPreflight(r));
        // Reporting only: a failed item is an answer, not an error. Exit 1 so a pipeline can gate on it.
        if (r.verdict !== "boxable") process.exitCode = 1;
      } finally {
        await close?.();
      }
    } else if (cmd === "digests" && flags.has("--in-use") && pos.length === 0) {
      // For a registry retention job: what must be kept. Reads the gateway's database; a node has none.
      if ((process.env.SLAUDE_ROLE ?? "").trim().toLowerCase() === "node") throw new PayloadError("box digests runs on the gateway or mono host (a node has no database)");
      const { digestsInUse } = await import("./box-digests");
      const { builtinBox } = await import("../box/builtin");
      const { db } = await import("../db/schema");
      const r = await digestsInUse(db, { builtin: builtinBox() });
      for (const image of r.images) console.log(image);
      if (r.unresolved) console.error(`[box] ${r.unresolved} session pin(s) name a box that is no longer stored; their repository is not known, so they are not listed`);
      await db.close?.();
    } else if (cmd === "check" && dir) {
      const r = checkBoxes(dir);
      for (const b of r.boxes) console.log(`ok  ${b.name}  (${b.image === "build" ? `build, context ${b.contextHash!.slice(0, 12)}` : "ref"})`);
      console.log(`${r.boxes.length} box${r.boxes.length === 1 ? "" : "es"} checked`);
      for (const n of r.notChecked) console.error(`[box] not checked here: ${n}`);
    } else {
      console.error(USAGE);
      process.exit(2);
    }
  } catch (e) {
    console.error(`[box] ${(e as Error).message}`);
    process.exit(1);
  }
}
