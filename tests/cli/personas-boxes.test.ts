/**
 * The box step of `personas render` and `slaude box check`: boxes/<name>/box.yaml
 * read and vetted, image.build resolved through the context hash and a registry
 * lookup (a fake registry here), and the payload carrying digests.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOX_YAML, checkBoxes, compileBoxes, contextHash, dockerResolver, readBoxDir, standInDigest, type ImageResolver } from "../../src/cli/box";
import { renderDir } from "../../src/cli/personas";
import { PayloadError, parsePayload } from "../../src/persona/sync/payload";

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const REF = `ghcr.io/example/boxes/py-dev@${digest("a")}`;
const REGISTRY = "ghcr.io/example/boxes";
const meta = { revision: "r1", committedAt: "2026-11-24T10:00:00Z" };

const buildYaml = (name: string, extra = "") => `version: 1\nname: ${name}\nimage:\n  build: {}\n${extra}`;
const refYaml = (name: string, extra = "") => `version: 1\nname: ${name}\nimage:\n  ref: ${REF}\n${extra}`;
const agent = (name: string, extra = "") =>
  name === "default"
    ? `name: default\nsoul: You are the default.\nmandate:\n  global: Default mandate.\naccess:\n  manager: UBOSS\n${extra}`
    : `name: ${name}\nslackUserId: U${name.toUpperCase()}1\nsoul: You are ${name}.\n${extra}`;

/** A deploy repository on disk. `boxes`: name to the files of its directory. */
function repo(o: { agents?: Record<string, string>; boxes?: Record<string, Record<string, string>> } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "slaude-boxes-"));
  for (const [name, body] of Object.entries(o.agents ?? { default: agent("default") })) {
    mkdirSync(join(dir, "personas", name), { recursive: true });
    writeFileSync(join(dir, "personas", name, "agent.yaml"), body);
  }
  if (o.boxes) {
    mkdirSync(join(dir, "boxes"), { recursive: true });
    for (const [name, files] of Object.entries(o.boxes)) {
      for (const [f, body] of Object.entries(files)) {
        mkdirSync(join(dir, "boxes", name, f, ".."), { recursive: true });
        writeFileSync(join(dir, "boxes", name, f), body);
      }
    }
  }
  return dir;
}
const err = async (f: () => unknown): Promise<PayloadError> => {
  try {
    await f();
  } catch (e) {
    expect(e).toBeInstanceOf(PayloadError);
    return e as PayloadError;
  }
  throw new Error("expected a throw");
};

/** A registry and builder in memory. */
function fakeRegistry(held: Record<string, string> = {}) {
  const calls: string[] = [];
  const resolver: ImageResolver = {
    lookup: async (repository, tag) => {
      calls.push(`lookup ${repository}:${tag}`);
      return held[`${repository}:${tag}`] ?? null;
    },
    build: async (o) => {
      calls.push(`build ${o.repository}:${o.tag} push=${o.push}`);
      if (!o.push) return null;
      held[`${o.repository}:${o.tag}`] = digest("b");
      return digest("b");
    },
  };
  return { resolver, calls, held };
}

describe("readBoxDir", () => {
  test("every box.yaml is parsed, in name order", () => {
    const dir = repo({ boxes: { "ruby-dev": { [BOX_YAML]: buildYaml("ruby-dev"), Dockerfile: "FROM debian:bookworm-slim\n" }, "py-dev": { [BOX_YAML]: refYaml("py-dev") } } });
    expect(readBoxDir(join(dir, "boxes")).map((e) => e.file.name)).toEqual(["py-dev", "ruby-dev"]);
  });

  test("a stray file, a bad directory name, a missing box.yaml and a bad box.yaml are refused", async () => {
    const stray = repo({ boxes: { "py-dev": { [BOX_YAML]: refYaml("py-dev") } } });
    writeFileSync(join(stray, "boxes", "notes.txt"), "x");
    expect((await err(() => readBoxDir(join(stray, "boxes")))).message).toMatch(/boxes\/ holds only <name>\/ directories/);
    const bad = repo({ boxes: { Bad_Name: { [BOX_YAML]: refYaml("py-dev") } } });
    expect((await err(() => readBoxDir(join(bad, "boxes")))).message).toMatch(/a directory name is not a valid box name/);
    const empty = repo({ boxes: { "py-dev": { "README.md": "x" } } });
    expect((await err(() => readBoxDir(join(empty, "boxes")))).message).toBe("box 'py-dev': boxes/py-dev/ has no box.yaml");
    const invalid = repo({ boxes: { "py-dev": { [BOX_YAML]: refYaml("py-dev", 'env:\n  A: "${B}"\n') } } });
    expect((await err(() => readBoxDir(join(invalid, "boxes")))).message).toMatch(/box 'py-dev': env\.A contains \$\{/);
  });

  test("a dot entry is skipped", () => {
    const dir = repo({ boxes: { "py-dev": { [BOX_YAML]: refYaml("py-dev") } } });
    writeFileSync(join(dir, "boxes", ".gitkeep"), "");
    expect(readBoxDir(join(dir, "boxes"))).toHaveLength(1);
  });
});

describe("contextHash", () => {
  const files = { [BOX_YAML]: buildYaml("ruby-dev"), Dockerfile: "FROM debian:bookworm-slim\n", "scripts/setup.sh": "echo hi\n" };
  const hashOf = (f: Record<string, string>) => contextHash(readBoxDir(join(repo({ boxes: { "ruby-dev": f } }), "boxes"))[0]!);

  test("the same files give the same hash; the Dockerfile and any context file change it", () => {
    const h = hashOf(files);
    expect(hashOf(files)).toBe(h);
    expect(hashOf({ ...files, Dockerfile: "FROM debian:trixie-slim\n" })).not.toBe(h);
    expect(hashOf({ ...files, "scripts/setup.sh": "echo bye\n" })).not.toBe(h);
    expect(hashOf({ ...files, "extra.txt": "" })).not.toBe(h);
  });

  test("a policy change in box.yaml is not an image change", () => {
    expect(hashOf({ ...files, [BOX_YAML]: buildYaml("ruby-dev", "egress:\n  allow: [pypi.org]\n") })).toBe(hashOf(files));
  });

  test("the executable bit and a symlink's target are part of the hash; a link is never followed", () => {
    const dir = repo({ boxes: { "ruby-dev": files } });
    const entry = readBoxDir(join(dir, "boxes"))[0]!;
    const h = contextHash(entry);
    chmodSync(join(dir, "boxes", "ruby-dev", "scripts", "setup.sh"), 0o755);
    const exec = contextHash(entry);
    expect(exec).not.toBe(h);
    symlinkSync("/etc/hostname", join(dir, "boxes", "ruby-dev", "link"));
    const linked = contextHash(entry);
    expect(linked).not.toBe(exec);
  });

  test("a Dockerfile or context that is missing or leaves the box directory is refused", async () => {
    const none = repo({ boxes: { "ruby-dev": { [BOX_YAML]: buildYaml("ruby-dev") } } });
    expect((await err(() => contextHash(readBoxDir(join(none, "boxes"))[0]!))).message).toBe("box 'ruby-dev': image.build.dockerfile does not exist in the box directory");
    const out = repo({ boxes: { "ruby-dev": { [BOX_YAML]: "version: 1\nname: ruby-dev\nimage:\n  build:\n    dockerfile: Dockerfile\n    context: ctx\n", Dockerfile: "FROM scratch\n" } } });
    symlinkSync(tmpdir(), join(out, "boxes", "ruby-dev", "ctx"));
    expect((await err(() => contextHash(readBoxDir(join(out, "boxes"))[0]!))).message).toBe("box 'ruby-dev': image.build.context leaves the box directory");
    const notDir = repo({ boxes: { "ruby-dev": { [BOX_YAML]: "version: 1\nname: ruby-dev\nimage:\n  build:\n    context: Dockerfile\n", Dockerfile: "FROM scratch\n" } } });
    expect((await err(() => contextHash(readBoxDir(join(notDir, "boxes"))[0]!))).message).toBe("box 'ruby-dev': image.build.context is not a directory");
    const notFile = repo({ boxes: { "ruby-dev": { [BOX_YAML]: "version: 1\nname: ruby-dev\nimage:\n  build:\n    dockerfile: sub\n", "sub/x": "" } } });
    expect((await err(() => contextHash(readBoxDir(join(notFile, "boxes"))[0]!))).message).toBe("box 'ruby-dev': image.build.dockerfile is not a file");
    const ref = repo({ boxes: { "py-dev": { [BOX_YAML]: refYaml("py-dev") } } });
    expect(() => contextHash(readBoxDir(join(ref, "boxes"))[0]!)).toThrow("not a build box");
  });
});

describe("compileBoxes", () => {
  const build = () => repo({ boxes: { "ruby-dev": { [BOX_YAML]: buildYaml("ruby-dev", "egress:\n  allow: [rubygems.org]\n"), Dockerfile: "FROM debian:bookworm-slim\n" }, "py-dev": { [BOX_YAML]: refYaml("py-dev") } } });

  test("image.ref is used as written, with no registry call", async () => {
    const dir = repo({ boxes: { "py-dev": { [BOX_YAML]: refYaml("py-dev") } } });
    const reg = fakeRegistry();
    const r = await compileBoxes(join(dir, "boxes"), { resolver: reg.resolver, mode: "push" });
    expect(r.boxes).toHaveLength(1);
    expect(r.boxes[0]!.image).toBe(REF);
    expect(reg.calls).toEqual([]);
    expect(r.unpushed).toEqual([]);
  });

  test("a build the registry lacks is built and pushed once; the next run reuses its digest", async () => {
    const dir = build();
    const reg = fakeRegistry();
    const logs: string[] = [];
    const first = await compileBoxes(join(dir, "boxes"), { resolver: reg.resolver, registry: `${REGISTRY}/`, mode: "push", log: (l) => logs.push(l) });
    const ruby = first.boxes.find((b) => b.name === "ruby-dev")!;
    expect(ruby.image).toBe(`${REGISTRY}/ruby-dev@${digest("b")}`);
    expect(ruby.egress).toEqual({ allow: ["rubygems.org"], deny: [] });
    expect(reg.calls.map((c) => c.split(" ")[0])).toEqual(["lookup", "build"]);
    expect(reg.calls[1]).toMatch(/^build ghcr\.io\/example\/boxes\/ruby-dev:ctx-[a-f0-9]{32} push=true$/);
    expect(logs).toEqual(["box 'ruby-dev': the registry has no image for this build context; building and pushing"]);
    const second = await compileBoxes(join(dir, "boxes"), { resolver: reg.resolver, registry: REGISTRY, mode: "push" });
    expect(second.boxes).toEqual(first.boxes);
    expect(reg.calls.filter((c) => c.startsWith("build"))).toHaveLength(1);
  });

  test("check mode builds without pushing and reports a stand-in digest, named as unpushed", async () => {
    const dir = build();
    const reg = fakeRegistry();
    const r = await compileBoxes(join(dir, "boxes"), { resolver: reg.resolver, registry: REGISTRY, mode: "check" });
    expect(reg.calls[1]).toMatch(/push=false$/);
    expect(r.unpushed).toEqual(["ruby-dev"]);
    const hash = contextHash(readBoxDir(join(dir, "boxes")).find((e) => e.file.name === "ruby-dev")!);
    expect(r.boxes.find((b) => b.name === "ruby-dev")!.image).toBe(`${REGISTRY}/ruby-dev@${standInDigest(hash)}`);
    expect(Object.keys(reg.held)).toEqual([]);
  });

  test("static mode touches no registry and no builder", async () => {
    const dir = build();
    const r = await compileBoxes(join(dir, "boxes"), { mode: "static" });
    expect(r.unpushed).toEqual(["ruby-dev"]);
    expect(r.boxes.find((b) => b.name === "ruby-dev")!.image).toMatch(/^registry\.invalid\/boxes\/ruby-dev@sha256:[a-f0-9]{64}$/);
    expect(r.boxes.find((b) => b.name === "py-dev")!.image).toBe(REF);
  });

  test("image.build without a registry, a malformed registry, a bad digest and a push that reports none are refused", async () => {
    const dir = build();
    const reg = fakeRegistry();
    expect((await err(() => compileBoxes(join(dir, "boxes"), { resolver: reg.resolver, mode: "push" }))).message).toMatch(/box 'ruby-dev': image\.build needs SLAUDE_BOX_REGISTRY/);
    expect((await err(() => compileBoxes(join(dir, "boxes"), { resolver: reg.resolver, registry: "https://ghcr.io/example", mode: "push" }))).message).toMatch(/SLAUDE_BOX_REGISTRY must be <registry>\/<repository prefix>/);
    const badDigest: ImageResolver = { lookup: async () => "latest", build: async () => null };
    expect((await err(() => compileBoxes(join(dir, "boxes"), { resolver: badDigest, registry: REGISTRY, mode: "push" }))).message).toMatch(/something that is not a sha256 digest/);
    const noDigest: ImageResolver = { lookup: async () => null, build: async () => null };
    expect((await err(() => compileBoxes(join(dir, "boxes"), { resolver: noDigest, registry: REGISTRY, mode: "push" }))).message).toMatch(/the build pushed no image/);
    await expect(compileBoxes(join(dir, "boxes"), { registry: REGISTRY, mode: "push" })).rejects.toThrow(/needs a resolver/);
  });
});

describe("dockerResolver", () => {
  const exec = (answers: Array<{ code: number; stdout?: string; stderr?: string }>, seen: string[][] = []) => {
    let i = 0;
    return {
      seen,
      run: async (argv: string[]) => {
        seen.push(argv);
        const a = answers[i++]!;
        return { code: a.code, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
      },
    };
  };

  test("lookup reads the manifest digest; an absent tag is null; any other failure is an error, never 'build it again'", async () => {
    const found = exec([{ code: 0, stdout: JSON.stringify({ digest: digest("c") }) }]);
    expect(await dockerResolver(found.run).lookup("ghcr.io/example/boxes/ruby-dev", "ctx-1")).toBe(digest("c"));
    expect(found.seen[0]).toEqual(["docker", "buildx", "imagetools", "inspect", "ghcr.io/example/boxes/ruby-dev:ctx-1", "--format", "{{json .Manifest}}"]);
    expect(await dockerResolver(exec([{ code: 1, stderr: "ERROR: ghcr.io/example/boxes/ruby-dev:ctx-1: not found" }]).run).lookup("r", "t")).toBeNull();
    expect(await dockerResolver(exec([{ code: 0, stdout: "{}" }]).run).lookup("r", "t")).toBeNull();
    expect((await err(() => dockerResolver(exec([{ code: 1, stderr: "denied: requested access to the resource is denied" }]).run).lookup("r", "t"))).message).toMatch(/registry lookup for a box image failed/);
    expect((await err(() => dockerResolver(exec([{ code: 0, stdout: "not json" }]).run).lookup("r", "t"))).message).toMatch(/unreadable/);
  });

  test("build passes argv (no shell), pushes only when asked, and a failed build is an error", async () => {
    const ok = exec([{ code: 0 }, { code: 0 }]);
    const r = dockerResolver(ok.run);
    expect(await r.build({ dockerfile: "/b/Dockerfile", context: "/b", repository: "ghcr.io/example/boxes/ruby-dev", tag: "ctx-1", push: false })).toBeNull();
    expect(ok.seen[0]!.slice(0, 7)).toEqual(["docker", "buildx", "build", "--file", "/b/Dockerfile", "--tag", "ghcr.io/example/boxes/ruby-dev:ctx-1"]);
    expect(ok.seen[0]).not.toContain("--push");
    expect(ok.seen[0]!.at(-1)).toBe("/b");
    // A push whose metadata file was never written reports no digest.
    expect(await r.build({ dockerfile: "/b/Dockerfile", context: "/b", repository: "r", tag: "t", push: true })).toBeNull();
    expect(ok.seen[1]).toContain("--push");
    expect((await err(() => dockerResolver(exec([{ code: 1 }]).run).build({ dockerfile: "/b/Dockerfile", context: "/b", repository: "r", tag: "t", push: true }))).message).toMatch(/failed to build/);
  });

  test("a push reads the digest from the metadata file the build wrote, and removes the file", async () => {
    const seen: string[][] = [];
    const run = async (argv: string[]) => {
      seen.push(argv);
      writeFileSync(argv[argv.indexOf("--metadata-file") + 1]!, JSON.stringify({ "containerimage.digest": digest("d") }));
      return { code: 0, stdout: "", stderr: "" };
    };
    expect(await dockerResolver(run).build({ dockerfile: "/b/Dockerfile", context: "/b", repository: "r", tag: "t", push: true })).toBe(digest("d"));
    const metaFile = seen[0]![seen[0]!.indexOf("--metadata-file") + 1]!;
    expect(await Bun.file(metaFile).exists()).toBe(false);
    expect(metaFile.startsWith("/b/")).toBe(false);
  });
});

describe("personas render with boxes/", () => {
  const boxes = async (dir: string) => (await compileBoxes(join(dir, "boxes"), { mode: "static" })).boxes;

  test("no folder: the payload has no boxes key and keeps its version", () => {
    const p = renderDir(repo({}), meta);
    expect("boxes" in p).toBe(false);
    expect(p.version).toBe(6);
  });

  test("a folder: version 8, entries the gateway's own parser accepts, and the persona's box in its definition", async () => {
    const dir = repo({ agents: { default: agent("default"), ana: agent("ana", "box: py-dev\n") }, boxes: { "py-dev": { [BOX_YAML]: refYaml("py-dev", "egress:\n  allow: [pypi.org]\n") } } });
    const p = renderDir(dir, meta, undefined, undefined, await boxes(dir));
    expect(p.version).toBe(8);
    expect(p.boxes).toHaveLength(1);
    expect(p.boxes![0]).toMatchObject({ name: "py-dev", image: REF, tier: "gvisor", egress: { allow: ["pypi.org"], deny: [] } });
    const wire = JSON.parse(JSON.stringify(p));
    const parsed = parsePayload(wire);
    expect(parsed.boxes![0]!.digest).toBe(digest("a"));
    expect(parsed.personas.find((x) => x.name === "ana")!.definition!.box).toBe("py-dev");
  });

  test("an empty folder is the whole set and needs version 8", () => {
    const p = renderDir(repo({ boxes: {} }), meta, undefined, undefined, []);
    expect(p.boxes).toEqual([]);
    expect(p.version).toBe(8);
  });

  test("a persona naming a box the repository does not have fails the render", async () => {
    const dir = repo({ agents: { default: agent("default"), ana: agent("ana", "box: nope\n") }, boxes: { "py-dev": { [BOX_YAML]: refYaml("py-dev") } } });
    const e = await err(async () => renderDir(dir, meta, undefined, undefined, await boxes(dir)));
    expect(e.message).toBe("persona 'ana': box names 'nope', but this repository has no boxes/nope/box.yaml");
  });

  test("a persona naming a box in a repository with no boxes/ folder is a warning: the gateway checks it", () => {
    const warnings: string[] = [];
    const p = renderDir(repo({ agents: { default: agent("default"), ana: agent("ana", "box: py-dev\n") } }), meta, undefined, (w) => warnings.push(...w));
    expect(p.version).toBe(8);
    expect("boxes" in p).toBe(false);
    expect(warnings.some((w) => w.includes("names a box, but this repository has no boxes/ folder"))).toBe(true);
  });
});

describe("slaude box check", () => {
  test("a deploy repository or a boxes folder: every box is checked and what is not checked is said", () => {
    const dir = repo({ boxes: { "ruby-dev": { [BOX_YAML]: buildYaml("ruby-dev"), Dockerfile: "FROM debian:bookworm-slim\n" }, "py-dev": { [BOX_YAML]: refYaml("py-dev") } } });
    const r = checkBoxes(dir);
    expect(r.boxes.map((b) => [b.name, b.image])).toEqual([["py-dev", "ref"], ["ruby-dev", "build"]]);
    expect(r.boxes[1]!.contextHash).toMatch(/^[a-f0-9]{64}$/);
    expect(r.notChecked.join(" ")).toContain("a node checks them when it unpacks the image");
    expect(checkBoxes(join(dir, "boxes")).boxes).toEqual(r.boxes);
  });

  test("a missing folder and a bad box are refused", async () => {
    expect((await err(() => checkBoxes(join(tmpdir(), "slaude-no-such-dir")))).message).toMatch(/no boxes\/ directory/);
    const bad = repo({ boxes: { "ruby-dev": { [BOX_YAML]: buildYaml("ruby-dev", "secrets:\n  A: b\n"), Dockerfile: "FROM scratch\n" } } });
    expect((await err(() => checkBoxes(bad))).message).toBe("box 'ruby-dev': secrets is not a known key");
  });

  test("the command prints one line per box and exits 0; a bad box exits 1; no arguments exits 2", async () => {
    const dir = repo({ boxes: { "py-dev": { [BOX_YAML]: refYaml("py-dev") } } });
    const runCli = async (args: string[]) => {
      const p = Bun.spawn(["bun", join(import.meta.dir, "../../src/cli/box.ts"), ...args], { stdout: "pipe", stderr: "pipe" });
      const [out, errText, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { out, errText, code };
    };
    const ok = await runCli(["check", dir]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("ok  py-dev  (ref)");
    expect(ok.out).toContain("1 box checked");
    const bad = repo({ boxes: { "py-dev": { [BOX_YAML]: refYaml("py-dev", "tier: microvm\n") } } });
    const failed = await runCli(["check", bad]);
    expect(failed.code).toBe(1);
    expect(failed.errText).toContain("[box] box 'py-dev': tier must be one of none, bwrap, gvisor");
    expect((await runCli([])).code).toBe(2);
  });
});
