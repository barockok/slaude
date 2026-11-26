/**
 * The built-in box: the default box that ships inside the slaude image (box
 * plan, Phase 9), so `box: default` and `SLAUDE_BOX_DEFAULT=default` resolve
 * with no entry in a deploy repository.
 *
 * Two files in the image, both written when the image is built:
 *
 *   boxes/default/box.yaml    the policy (the file in this repository)
 *   boxes/default/image.ref   one line per architecture:
 *                             `<amd64|arm64>=<repository>@sha256:<digest>`
 *
 * Trust: these files are part of the image, exactly like the code that reads
 * them. Whoever can change them can change the gateway. So the built-in is
 * not in the signed set and needs no signature of its own. It never weakens
 * the signed set either: it is consulted only AFTER the tenant's stored set
 * has verified, and only for a name that set does not hold. A stored box of
 * the same name always wins, and a stored set that fails its check fails
 * closed without a look at this file.
 *
 * Without image.ref (a source checkout, the test suite, a build that did not
 * publish a box image) there is no built-in and nothing changes.
 *
 * One digest per architecture, not one index digest: a node fetches an image
 * by digest and checks that the manifest it got hashes to the pinned digest,
 * and what it gets from a multi-platform index is one platform's manifest,
 * whose digest is not the index's. The gateway serves the digest of its OWN
 * architecture, on the assumption that a deployment's gateway and nodes run
 * the same image on the same architecture. A deployment that mixes them
 * defines its own `default` box in its deploy repository.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BOX_IMAGE_REF_RE, digestOf, isStandInImage, parseBoxYaml } from "./definition";
import type { BoxPolicy } from "./policy";

export const BUILTIN_BOX_NAME = "default";
export const BUILTIN_BOX_REF_FILE = "image.ref";

export interface BuiltinBox {
  name: string;
  description: string;
  /** `<repository>@sha256:<digest>` for this process's architecture. */
  image: string;
  /** `sha256:<digest>`. */
  digest: string;
  policy: BoxPolicy;
  /** Every image the file lists, all architectures: what a registry retention job must keep. */
  images: string[];
}

/** The architecture names of image.ref (the container platform's), for a Node `process.arch`. */
export function builtinArch(arch: string = process.arch): string {
  return arch === "x64" ? "amd64" : arch;
}

/** Parse image.ref. Throws with a message that names the line, never more. */
export function parseBuiltinRefs(text: string): Map<string, string> {
  const out = new Map<string, string>();
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const eq = line.indexOf("=");
    const arch = eq > 0 ? line.slice(0, eq) : "";
    const image = eq > 0 ? line.slice(eq + 1) : "";
    if (!/^[a-z0-9]{1,16}$/.test(arch) || !BOX_IMAGE_REF_RE.test(image)) throw new Error(`line ${i + 1} is not <architecture>=<registry>/<repository>@sha256:<digest>`);
    if (isStandInImage(image)) throw new Error(`line ${i + 1} names a stand-in digest, not a pushed image`);
    if (out.has(arch)) throw new Error(`line ${i + 1} repeats an architecture`);
    out.set(arch, image);
  });
  return out;
}

/** Read the built-in from a directory. Null when it has no image.ref. Throws when the files are there and unusable. */
export function readBuiltinBox(dir: string, arch: string = builtinArch()): BuiltinBox | null {
  const refFile = join(dir, BUILTIN_BOX_REF_FILE);
  if (!existsSync(refFile)) return null;
  const refs = parseBuiltinRefs(readFileSync(refFile, "utf8"));
  if (refs.size === 0) return null;
  const image = refs.get(arch);
  if (!image) throw new Error(`${BUILTIN_BOX_REF_FILE} lists no image for architecture ${arch} (it has ${[...refs.keys()].sort().join(", ")})`);
  const file = parseBoxYaml(BUILTIN_BOX_NAME, readFileSync(join(dir, "box.yaml"), "utf8"));
  return { name: file.name, description: file.description, image, digest: digestOf(image), policy: file.policy, images: [...refs.values()].sort() };
}

/** `<repository root>/boxes/default`: /app/boxes/default in the image. */
const SHIPPED_DIR = join(import.meta.dir, "..", "..", "boxes", BUILTIN_BOX_NAME);
let dirOverride: string | null | undefined;
let memo: { box: BuiltinBox | null } | undefined;

/**
 * The built-in box of this process, read once. Null when there is none, and
 * also when its files are unusable: that is logged once, and a persona that
 * names it is then refused like any persona naming a box nobody defined. It
 * is never a reason to run unboxed.
 */
export function builtinBox(): BuiltinBox | null {
  if (memo) return memo.box;
  let box: BuiltinBox | null = null;
  try {
    box = dirOverride === null ? null : readBuiltinBox(dirOverride ?? SHIPPED_DIR);
  } catch (e) {
    console.error(`[box] the built-in default box cannot be used: ${e instanceof Error ? e.message : String(e)}`);
  }
  memo = { box };
  return box;
}

/** TEST SEAM: read the built-in from `dir` (null: there is none; undefined: the shipped location again). */
export function __setBuiltinBoxDirForTests(dir: string | null | undefined): void {
  dirOverride = dir;
  memo = undefined;
}
