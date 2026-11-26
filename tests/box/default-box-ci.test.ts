/**
 * How the default box reaches a release (box plan, Phase 9), checked on the
 * files: both workflows build the box image before the slaude image and hand
 * it the digests; the box build gets no secret; the steps that were there
 * before are still there; the Dockerfile's default target is still the last
 * one. And the script that turns a pushed digest into per-architecture
 * references, against a fake `docker`.
 *
 * Static only. NOT RUN: neither workflow has executed with these steps, and no
 * image was built from this Dockerfile here.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { parseBuiltinRefs } from "../../src/box/builtin";

const root = join(import.meta.dir, "../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
type Step = { name?: string; id?: string; uses?: string; if?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> };
const steps = (file: string, job: string): Step[] => (parse(read(file)) as { jobs: Record<string, { steps: Step[] }> }).jobs[job]!.steps;
const idx = (list: Step[], name: string) => {
  const i = list.findIndex((s) => s.name === name);
  if (i < 0) throw new Error(`no step named '${name}'`);
  return i;
};

describe.each([
  { file: ".github/workflows/docker.yml", job: "build", slaude: "Build and push", resolve: "Resolve the default box digests", arches: "amd64 arm64", platforms: "linux/amd64,linux/arm64" },
  { file: ".github/workflows/release.yml", job: "release", slaude: "Build and push Docker image", resolve: "Resolve the default box digest", arches: "amd64", platforms: "linux/amd64" },
])("$file", ({ file, job, slaude, resolve, arches, platforms }) => {
  const list = steps(file, job);
  const box = list[idx(list, "Build and push the default box")]!;
  const refs = list[idx(list, resolve)]!;
  const main = list[idx(list, slaude)]!;

  test("the box image is built, its digests resolved, and only then the slaude image", () => {
    expect(idx(list, "Build and push the default box")).toBeLessThan(idx(list, resolve));
    expect(idx(list, resolve)).toBeLessThan(idx(list, slaude));
    // After the registry login, or the push has no credentials.
    expect(idx(list, "Log in to GHCR")).toBeLessThan(idx(list, "Build and push the default box"));
  });

  test("the box build: its own context, its own repository, OCI media types, no attestation manifest", () => {
    expect(box.uses).toBe("docker/build-push-action@v6");
    expect(box.id).toBe("box");
    expect(box.with!.context).toBe("boxes/default");
    expect(box.with!.platforms).toBe(platforms);
    expect(String(box.with!.outputs)).toMatch(/^type=image,oci-mediatypes=true,push=/);
    expect(box.with!.provenance).toBe(false);
    expect(box.with!.sbom).toBe(false);
    expect(box.with!.push).toBeUndefined();
    expect(box.with!.tags).toBe("${{ steps.boxmeta.outputs.tags }}");
    const meta = list.find((s) => s.id === "boxmeta")!;
    expect(String(meta.with!.images)).toMatch(/-box-default$/);
  });

  test("no secret, no build argument and no token reaches the box build", () => {
    expect(Object.keys(box.with!).sort()).not.toContain("build-args");
    for (const k of ["secrets", "secret-files", "secret-envs", "ssh", "github-token", "build-contexts"]) expect(box.with![k]).toBeUndefined();
    expect(box.env).toBeUndefined();
    expect(JSON.stringify(box)).not.toMatch(/secrets\.|GITHUB_TOKEN|password/i);
    expect(JSON.stringify(refs)).not.toMatch(/secrets\.|GITHUB_TOKEN|password/i);
  });

  test("the digests reach the slaude build as BOX_DEFAULT_IMAGES, through the script, by environment not by splice", () => {
    expect(refs.id).toBe("boxrefs");
    expect(refs.env!.BOX_DIGEST).toBe("${{ steps.box.outputs.digest }}");
    expect(refs.run).toContain(`scripts/box-default-refs.sh "$repo" "$BOX_DIGEST" ${arches}`);
    expect(refs.run).toContain('echo "images=${images}" >> "$GITHUB_OUTPUT"');
    expect(refs.run).not.toContain("${{");
    expect(String(main.with!["build-args"]).trim()).toBe("BOX_DEFAULT_IMAGES=${{ steps.boxrefs.outputs.images }}");
  });

  test("the slaude build is what it was: same context, tags, labels and push rule", () => {
    expect(main.uses).toBe("docker/build-push-action@v6");
    expect(main.with!.context).toBe(".");
    expect(main.with!.tags).toBe("${{ steps.meta.outputs.tags }}");
    expect(main.with!.labels).toBe("${{ steps.meta.outputs.labels }}");
    expect(main.with!.builder).toBeUndefined();
    expect(main.with!.target).toBeUndefined();
  });
});

describe("docker.yml keeps its behaviour", () => {
  const list = steps(".github/workflows/docker.yml", "build");
  test("every earlier step is still there, in order, and its tags are unchanged", () => {
    const names = list.map((s) => s.name ?? s.uses);
    const before = ["actions/checkout@v4", "Set up QEMU", "Set up Docker Buildx", "Log in to GHCR", "Extract metadata", "Build and push"];
    expect(names.filter((n) => before.includes(n!))).toEqual(before);
    const meta = list.find((s) => s.id === "meta")!;
    expect(meta.with!.images).toBe("${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}");
    expect(String(meta.with!.tags).trim().split("\n").map((l) => l.trim())).toEqual([
      "type=ref,event=branch", "type=ref,event=pr", "type=semver,pattern={{version}}", "type=semver,pattern={{major}}.{{minor}}", "type=semver,pattern={{major}}",
      "type=sha,format=short", "type=raw,value=latest,enable={{is_default_branch}}",
    ]);
    const main = list[idx(list, "Build and push")]!;
    expect(main.with!.platforms).toBe("linux/amd64,linux/arm64");
    expect(main.with!.push).toBe("${{ github.event_name != 'pull_request' }}");
    expect(main.with!["cache-from"]).toBe("type=gha");
  });

  test("a pull request builds both images and pushes neither; the slaude image then has no built-in box", () => {
    const box = list[idx(list, "Build and push the default box")]!;
    expect(box.if).toBeUndefined();
    expect(String(box.with!.outputs)).toBe("type=image,oci-mediatypes=true,push=${{ github.event_name != 'pull_request' }}");
    expect(list[idx(list, "Resolve the default box digests")]!.if).toBe("github.event_name != 'pull_request'");
    expect(list[idx(list, "Log in to GHCR")]!.if).toBe("github.event_name != 'pull_request'");
  });
});

describe("release.yml keeps its behaviour", () => {
  const list = steps(".github/workflows/release.yml", "release");
  test("every earlier step is still there, in order; the box builder is not made the default", () => {
    const before = [
      "Verify tag matches package.json version", "Setup Bun", "Install dependencies", "Run tests with coverage", "Generate changelog", "Package release tarball",
      "Installer smoke test", "Create GitHub release (draft)", "Publish release", "Log in to GHCR", "Docker meta", "Build and push Docker image",
    ];
    expect(list.map((s) => s.name).filter((n) => before.includes(n!))).toEqual(before);
    const builder = list.find((s) => s.id === "boxbuilder")!;
    expect(builder.uses).toBe("docker/setup-buildx-action@v3");
    expect(builder.with!.use).toBe(false);
    expect(list[idx(list, "Build and push the default box")]!.with!.builder).toBe("${{ steps.boxbuilder.outputs.name }}");
    const main = list[idx(list, "Build and push Docker image")]!;
    expect(main.with!.push).toBe(true);
    const meta = list.find((s) => s.id === "meta")!;
    expect(meta.with!.images).toBe("ghcr.io/${{ github.repository }}");
  });

  test("the box image is published after the release itself, so a failed box build never blocks the tarball", () => {
    expect(idx(list, "Publish release")).toBeLessThan(idx(list, "Build and push the default box"));
  });
});

describe("Dockerfile targets", () => {
  const text = read("Dockerfile");
  const froms = text.split("\n").filter((l) => /^FROM /.test(l));

  test("base, then the optional node-box, then the default image last and unnamed", () => {
    expect(froms.slice(-3)).toEqual(["FROM oven/bun:1.3-debian AS base", "FROM base AS node-box", "FROM base"]);
    expect(froms.filter((l) => / AS /.test(l)).map((l) => l.split(" AS ")[1])).toEqual(["deps", "web", "builder", "boxinit", "base", "node-box"]);
  });

  test("uv and the prefetched MCP server are in the default image only", () => {
    const last = text.slice(text.lastIndexOf("\nFROM base\n"));
    const shared = text.slice(text.indexOf("FROM oven/bun:1.3-debian AS base"), text.indexOf("FROM base AS node-box"));
    const nodeBox = text.slice(text.indexOf("FROM base AS node-box"), text.lastIndexOf("\nFROM base\n"));
    expect(last).toContain("astral.sh/uv/install.sh");
    expect(last).toContain("uvx --from mcp-grafana mcp-grafana --help");
    for (const part of [shared, nodeBox]) expect(part).not.toMatch(/^\s*(?:RUN|&&).*\buvx?\b/m);
    expect(nodeBox).not.toMatch(/^(?:RUN|COPY|ADD) /m);
  });

  test("everything a node or the supervisor runs is in the shared base, and the entry is unchanged", () => {
    const shared = text.slice(text.indexOf("FROM oven/bun:1.3-debian AS base"), text.indexOf("FROM base AS node-box"));
    for (const s of ["ca-certificates git curl", "tailcat", "RUNSC_VERSION", "bubblewrap skopeo umoci zstd util-linux tini", "COPY --from=boxinit /out/box-init /usr/local/lib/slaude-box/box-init", "COPY src ./src", "ENV SLAUDE_HOME=/data", 'CMD ["bun", "run", "start"]']) {
      expect(shared).toContain(s);
    }
    // The lines the box smoke script cuts out of this file are still where it looks for them.
    expect(text).toMatch(/^FROM oven\/bun:1\.3-debian AS boxinit$/m);
    expect(text).toMatch(/^ARG RUNSC_VERSION=/m);
  });

  test("the default box's policy is copied in, and image.ref is written only from the build argument, checked", () => {
    const shared = text.slice(text.indexOf("FROM oven/bun:1.3-debian AS base"), text.indexOf("FROM base AS node-box"));
    expect(shared).toContain("COPY boxes/default/box.yaml ./boxes/default/box.yaml");
    expect(shared).toContain('ARG BOX_DEFAULT_IMAGES=""');
    expect(shared).toContain('if [ -n "$BOX_DEFAULT_IMAGES" ]; then');
    expect(shared).toContain("> boxes/default/image.ref");
    expect(shared).toContain("^(amd64|arm64)=");
    // No other build argument of this image names a credential.
    expect(text).not.toMatch(/^ARG [A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_?KEY|CREDENTIAL)/m);
  });
});

describe("scripts/box-default-refs.sh", () => {
  const script = join(root, "scripts/box-default-refs.sh");
  const repo = "ghcr.io/example/slaude-box-default";
  const d = (c: string) => `sha256:${c.repeat(64)}`;
  const made: string[] = [];
  afterAll(() => {
    for (const m of made) rmSync(m, { recursive: true, force: true });
  });
  /** Run the script with a `docker` that prints `raw` for `buildx imagetools inspect --raw <ref>` and records its arguments. */
  function run(raw: unknown, args: string[]): { code: number; out: string; err: string; asked: string } {
    const dir = mkdtempSync(join(tmpdir(), "box-refs-"));
    made.push(dir);
    writeFileSync(join(dir, "raw.json"), JSON.stringify(raw));
    writeFileSync(join(dir, "docker"), `#!/bin/sh\necho "$@" > "${dir}/asked"\ncat "${dir}/raw.json"\n`);
    chmodSync(join(dir, "docker"), 0o755);
    const r = Bun.spawnSync(["bash", script, ...args], { env: { PATH: `${dir}:${process.env.PATH}` } });
    let asked = "";
    try {
      asked = readFileSync(join(dir, "asked"), "utf8").trim();
    } catch {}
    return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim(), asked };
  }
  const index = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      { digest: d("a"), platform: { os: "linux", architecture: "amd64" } },
      { digest: d("b"), platform: { os: "linux", architecture: "arm64" } },
      { digest: d("e"), platform: { os: "unknown", architecture: "unknown" } },
    ],
  };

  test("an index: each architecture's own manifest digest, never the index's; the output is what the gateway reads", () => {
    const r = run(index, [repo, d("f"), "amd64", "arm64"]);
    expect(r.code).toBe(0);
    expect(r.asked).toBe(`buildx imagetools inspect --raw ${repo}@${d("f")}`);
    expect(r.out).toBe(`amd64=${repo}@${d("a")},arm64=${repo}@${d("b")}`);
    expect(r.out).not.toContain(d("f"));
    expect([...parseBuiltinRefs(r.out.split(",").join("\n"))]).toEqual([["amd64", `${repo}@${d("a")}`], ["arm64", `${repo}@${d("b")}`]]);
  });

  test("a one-platform push is a manifest: its own digest is that platform's", () => {
    const r = run({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config: {}, layers: [] }, [repo, d("c"), "amd64"]);
    expect([r.code, r.out]).toEqual([0, `amd64=${repo}@${d("c")}`]);
    expect(run({ schemaVersion: 2, config: {}, layers: [] }, [repo, d("c"), "amd64", "arm64"]).code).toBe(1);
  });

  test("a missing architecture, two manifests of one, a tag, an upper-case repository and a bad digest all fail", () => {
    expect(run({ manifests: [index.manifests[0]] }, [repo, d("f"), "amd64", "arm64"])).toMatchObject({ code: 1, out: "" });
    expect(run({ manifests: [index.manifests[0], { ...index.manifests[0], digest: d("b") }] }, [repo, d("f"), "amd64"]).code).toBe(1);
    expect(run(index, [`${repo}:latest@x`, d("f"), "amd64"]).code).toBe(1);
    expect(run(index, ["ghcr.io/Example/box", d("f"), "amd64"]).code).toBe(1);
    expect(run(index, [repo, "sha256:abc", "amd64"]).code).toBe(1);
    expect(run(index, [repo, d("f"), "riscv64"]).code).toBe(1);
    expect(run(index, [repo]).code).toBe(2);
  });
});
