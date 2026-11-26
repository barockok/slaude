/**
 * A tiny OCI image layout on disk, for tests of the box image cache. It is a
 * real layout as far as the cache reads one (oci-layout, index.json, a
 * manifest blob stored under its own sha256), with one "layer" that is a JSON
 * map of path to text instead of a tar: the fake runner below unpacks that,
 * standing in for umoci. Nothing here needs skopeo, umoci, root or Linux.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { ImageRunner } from "../../src/box/image";

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

/** The files of a root filesystem that passes the box image checks. */
export function goodRootfs(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "etc/passwd": "root:x:0:0:root:/root:/bin/sh\nagent:x:10001:10001::/home/agent:/bin/bash\n",
    "home/agent/.profile": "# agent\n",
    "usr/bin/git": "#!/bin/sh\n",
    "etc/ssl/certs/ca-certificates.crt": "-- test bundle --\n",
    "lib/x86_64-linux-gnu/libc.so.6": "glibc\n",
    ...extra,
  };
}

/** Write a layout holding one image; returns its manifest digest (`sha256:<hex>`). */
export function writeOciLayout(dir: string, files: Record<string, string> = goodRootfs(), o: { tag?: string | null } = {}): string {
  const blobs = join(dir, "blobs", "sha256");
  mkdirSync(blobs, { recursive: true });
  const put = (body: string): { digest: string; size: number } => {
    const hex = sha(body);
    writeFileSync(join(blobs, hex), body);
    return { digest: `sha256:${hex}`, size: Buffer.byteLength(body) };
  };
  const layer = put(JSON.stringify(files));
  const config = put(JSON.stringify({ architecture: "amd64", os: "linux", rootfs: { type: "layers", diff_ids: [layer.digest] } }));
  const manifest = put(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { mediaType: "application/vnd.oci.image.config.v1+json", ...config },
      layers: [{ mediaType: "application/vnd.slaude.test.files+json", ...layer }],
    }),
  );
  writeFileSync(join(dir, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  const tag = o.tag === undefined ? "box" : o.tag;
  writeFileSync(
    join(dir, "index.json"),
    JSON.stringify({
      schemaVersion: 2,
      manifests: [{ mediaType: "application/vnd.oci.image.manifest.v1+json", ...manifest, ...(tag ? { annotations: { "org.opencontainers.image.ref.name": tag } } : {}) }],
    }),
  );
  return manifest.digest;
}

/** Every file of a directory, as relative path to bytes (for a static server). */
export function layoutFiles(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(dir, p).split("\\").join("/"), readFileSync(p));
    }
  };
  walk(dir);
  return out;
}

/** The fake umoci: read the layout's one layer (a JSON file map) and write it out. */
export function unpackTestLayout(layoutDir: string, rootfsDir: string): void {
  const index = JSON.parse(readFileSync(join(layoutDir, "index.json"), "utf8")) as { manifests: Array<{ digest: string }> };
  const blob = (digest: string) => readFileSync(join(layoutDir, "blobs", "sha256", digest.slice(7)), "utf8");
  const manifest = JSON.parse(blob(index.manifests[0]!.digest)) as { layers: Array<{ digest: string }> };
  const files = JSON.parse(blob(manifest.layers[0]!.digest)) as Record<string, string>;
  mkdirSync(rootfsDir, { recursive: true });
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(rootfsDir, path)), { recursive: true });
    writeFileSync(join(rootfsDir, path), body);
  }
}

export interface FakeRunner extends ImageRunner {
  calls: string[];
}

/**
 * A runner whose `pull` copies from a map of image reference to a layout
 * directory on disk (a registry that is a folder), and whose `unpack` is the
 * fake umoci. `delayMs` makes a pull slow, to test deadlines.
 */
export function fakeRunner(registry: Record<string, string>, o: { delayMs?: number } = {}): FakeRunner {
  const calls: string[] = [];
  return {
    calls,
    async pull(image, layoutDir, { signal }) {
      calls.push(`pull ${image}`);
      if (o.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, o.delayMs);
          signal?.addEventListener("abort", () => (clearTimeout(t), reject(new Error("aborted"))), { once: true });
        });
      }
      const src = registry[image];
      if (!src || !existsSync(src)) throw new Error("manifest unknown");
      cpSync(src, layoutDir, { recursive: true });
    },
    async unpack(layoutDir, rootfsDir) {
      calls.push("unpack");
      unpackTestLayout(layoutDir, rootfsDir);
    },
  };
}
