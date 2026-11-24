/**
 * The built-in default box (box plan, Phase 9): the files in this repository,
 * the reader of the two files an image carries, and how the gateway's
 * registry serves it: only after the stored set verified, never over a stored
 * box of the same name, and never moving a pinned session.
 *
 * The registry half runs on a PGLite database of its own.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DbClient, openDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import { __resetGuardrailKeyForTests } from "../../src/guardrails/integrity";
import { __setBuiltinBoxDirForTests, BUILTIN_BOX_NAME, builtinArch, builtinBox, parseBuiltinRefs, readBuiltinBox } from "../../src/box/builtin";
import { parseBoxPayload, parseBoxYaml, standInDigestFor } from "../../src/box/definition";
import { BoxIntegrityError } from "../../src/box/integrity";
import { BOX_AGENT_UID } from "../../src/box/image";
import { __clearBoxesForTests, applyBoxes } from "../../src/db/boxes";
import { __resetBoxRegistryForTests, boxSnapshot, currentBox, loadBoxes, pinnedBox, versionAt } from "../../src/gateway/core/box-registry";
import { boxesForLabels } from "../../src/gateway/api/node-boxes";
import { isStale, refresh, type BoxRefreshDeps } from "../../src/gateway/core/box-refresh";
import { checkBoxes } from "../../src/cli/box";
import { digestsInUse } from "../../src/cli/box-digests";

const root = join(import.meta.dir, "../..");
const shipped = join(root, "boxes", "default");
const T = "default";
const digest = (c: string) => `sha256:${c.repeat(64)}`;
const REPO = "ghcr.io/example/slaude-box-default";
const ref = (c: string, repo = REPO) => `${repo}@${digest(c)}`;

const made: string[] = [];
/** A directory shaped like /app/boxes/default in an image. */
function imageDir(refs: string | null, yaml = readFileSync(join(shipped, "box.yaml"), "utf8")): string {
  const dir = mkdtempSync(join(tmpdir(), "builtin-box-"));
  made.push(dir);
  writeFileSync(join(dir, "box.yaml"), yaml);
  if (refs !== null) writeFileSync(join(dir, "image.ref"), refs);
  return dir;
}
const bothArch = (c: string, d = c) => `amd64=${ref(c)}\narm64=${ref(d)}\n`;

afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
  __setBuiltinBoxDirForTests(undefined);
});

describe("boxes/default in this repository", () => {
  const yaml = readFileSync(join(shipped, "box.yaml"), "utf8");
  const dockerfile = readFileSync(join(shipped, "Dockerfile"), "utf8");

  test("box.yaml is a valid box named default, built from its own directory, and passes `slaude box check`", () => {
    const f = parseBoxYaml("default", yaml);
    expect(f.name).toBe(BUILTIN_BOX_NAME);
    expect(f.image).toEqual({ build: { dockerfile: "Dockerfile", context: "." } });
    expect(f.policy.tier).toBe("gvisor");
    expect(f.policy.refresh.force).toBe(false);
    expect(f.policy.mcp.stdio).toEqual({});
    const checked = checkBoxes(root).boxes.find((b) => b.name === "default")!;
    expect(checked.image).toBe("build");
    expect(checked.contextHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("its egress list holds the common registries and code hosts, by name, with no wildcard", () => {
    const { allow, deny } = parseBoxYaml("default", yaml).policy.egress;
    for (const h of ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "crates.io", "proxy.golang.org", "sum.golang.org", "github.com", "codeload.github.com", "raw.githubusercontent.com", "objects.githubusercontent.com", "gitlab.com", "bitbucket.org", "deb.debian.org"]) {
      expect(allow).toContain(h);
    }
    expect(allow.filter((h) => h.startsWith("*."))).toEqual([]);
    expect(deny).toContain("uploads.github.com");
    expect(yaml).toContain("starting point");
  });

  test("package managers point at the home, in the box's env and in the image", () => {
    const env = parseBoxYaml("default", yaml).policy.env;
    expect(env).toMatchObject({ NPM_CONFIG_PREFIX: "/home/agent/.npm-global", PIP_USER: "1", GOPATH: "/home/agent/go" });
    for (const v of Object.values(env)) if (v.startsWith("/")) expect(v.startsWith("/home/agent/")).toBe(true);
    for (const name of Object.keys(env)) expect(dockerfile).toContain(`${name}=`);
    // Only PATH of an image's environment reaches a box: the home's bin directories must be on it.
    const path = /\sPATH=(\S+)/.exec(dockerfile)![1]!;
    for (const d of ["/home/agent/.local/bin", "/home/agent/.bun/bin", "/home/agent/.npm-global/bin", "/home/agent/go/bin", "/usr/local/bin", "/usr/bin"]) expect(path.split(":")).toContain(d);
  });

  test("the Dockerfile gives what a node checks for, the tools of the slaude image, and no secret", () => {
    expect(dockerfile).toContain("FROM debian:bookworm-slim");
    expect(dockerfile).toContain(`groupadd --gid ${BOX_AGENT_UID} agent`);
    expect(dockerfile).toContain(`useradd --uid ${BOX_AGENT_UID} --gid ${BOX_AGENT_UID} --create-home --home-dir /home/agent`);
    for (const tool of ["ca-certificates", "git", "curl"]) expect(dockerfile).toMatch(new RegExp(`apt-get install[^\\n]*\\b${tool}\\b`));
    expect(dockerfile).toContain("/usr/local/bin/bun");
    expect(dockerfile).toContain("astral.sh/uv/install.sh");
    // Nothing is handed to the build, and nothing in it is named like a credential.
    expect(dockerfile).not.toMatch(/^\s*ARG\b/m);
    expect(dockerfile).not.toMatch(/--mount=type=secret|\$\{/);
    expect(dockerfile).not.toMatch(/^(?:ENV|ARG)[^\n]*(?:TOKEN|SECRET|PASSWORD|API_?KEY|CREDENTIAL)/im);
  });
});

describe("image.ref and the reader", () => {
  test("no image.ref: there is no built-in (this checkout, and every test)", () => {
    expect(readBuiltinBox(shipped)).toBeNull();
    expect(readBuiltinBox(imageDir(null))).toBeNull();
    expect(readBuiltinBox(imageDir("\n# nothing published\n"))).toBeNull();
    __setBuiltinBoxDirForTests(undefined);
    expect(builtinBox()).toBeNull();
  });

  test("the image of this process's architecture is the box's; every listed image is kept for retention", () => {
    const dir = imageDir(bothArch("a", "b"));
    const amd = readBuiltinBox(dir, "amd64")!;
    const arm = readBuiltinBox(dir, "arm64")!;
    expect([amd.image, amd.digest]).toEqual([ref("a"), digest("a")]);
    expect([arm.image, arm.digest]).toEqual([ref("b"), digest("b")]);
    expect(amd.images).toEqual([ref("a"), ref("b")]);
    expect(amd.policy).toEqual(parseBoxYaml("default", readFileSync(join(shipped, "box.yaml"), "utf8")).policy);
    expect(builtinArch("x64")).toBe("amd64");
    expect(builtinArch("arm64")).toBe("arm64");
  });

  test("a file that is there and unusable is an error, never a guess", () => {
    expect(() => readBuiltinBox(imageDir(`amd64=${ref("a")}\n`), "arm64")).toThrow(/no image for architecture arm64/);
    expect(() => parseBuiltinRefs(`amd64=${REPO}:latest`)).toThrow(/line 1 is not/);
    expect(() => parseBuiltinRefs(`${ref("a")}`)).toThrow(/line 1 is not/);
    expect(() => parseBuiltinRefs(`amd64=${ref("a")}\namd64=${ref("b")}`)).toThrow(/line 2 repeats/);
    expect(() => parseBuiltinRefs(`amd64=${REPO}@${standInDigestFor("c".repeat(64))}`)).toThrow(/stand-in/);
    expect(() => readBuiltinBox(imageDir(bothArch("a"), "version: 1\nname: default\nimage: { build: {} }\nenv: { A: \"${X}\" }\n"), "amd64")).toThrow(/contains \$\{/);
  });

  test("an unusable built-in is logged once and reads as none", () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      __setBuiltinBoxDirForTests(imageDir("amd64=not-an-image\n"));
      expect(builtinBox()).toBeNull();
      expect(builtinBox()).toBeNull();
      expect(err).toHaveBeenCalledTimes(1);
    } finally {
      err.mockRestore();
      __setBuiltinBoxDirForTests(undefined);
    }
  });
});

describe("the registry", () => {
  let db: DbClient;
  let savedKey: string | undefined;
  const stored = (name: string, c: string, over: Record<string, unknown> = {}) => parseBoxPayload({ name, image: `ghcr.io/example/boxes/${name}@${digest(c)}`, ...over });
  const sync = (list: ReturnType<typeof stored>[], tenant = T) => db.transaction((tx) => applyBoxes(tx, tenant, list, { by: "ci", now: 1000 }));
  const use = (c: string | null) => __setBuiltinBoxDirForTests(c === null ? null : imageDir(bothArch(c)));

  beforeAll(async () => {
    savedKey = process.env.SLAUDE_MASTER_KEY;
    process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
    __resetMasterKeyCache();
    __resetGuardrailKeyForTests();
    db = await openDb({ dialect: "pg", driver: "pglite" });
    await runMigrations(db, { log: () => {} });
  });
  afterAll(async () => {
    await db.close();
    if (savedKey === undefined) delete process.env.SLAUDE_MASTER_KEY;
    else process.env.SLAUDE_MASTER_KEY = savedKey;
    __resetMasterKeyCache();
    __resetGuardrailKeyForTests();
  });
  beforeEach(async () => {
    await __clearBoxesForTests(db);
    await db.run(`DELETE FROM sessions WHERE id LIKE 'builtin-%'`);
    __resetBoxRegistryForTests();
    use(null);
  });

  test("without a built-in the snapshot is the stored set, as before", async () => {
    expect((await loadBoxes(T, db)).boxes.size).toBe(0);
    expect(await currentBox(T, "default", db)).toBeNull();
  });

  test("with one, `default` resolves with nothing stored: version 0, the shipped policy, for every tenant", async () => {
    use("a");
    const snap = await boxSnapshot(T, db);
    expect(snap.setVersion).toBe(0);
    const e = snap.boxes.get("default")!;
    expect(e.builtin).toBe(true);
    expect(e.versions).toEqual([e.current]);
    expect(e.current).toMatchObject({ name: "default", version: 0, image: ref("a"), digest: digest("a"), forced: false });
    expect(e.current.policy.egress.allow).toContain("registry.npmjs.org");
    expect((await currentBox("t2", "default", db))!.digest).toBe(digest("a"));
    expect(await currentBox(T, "ruby-dev", db)).toBeNull();
  });

  test("it sits beside stored boxes, and a stored `default` always wins", async () => {
    use("a");
    await sync([stored("ruby-dev", "b")]);
    __resetBoxRegistryForTests();
    const snap = await boxSnapshot(T, db);
    expect([...snap.boxes.keys()].sort()).toEqual(["default", "ruby-dev"]);
    expect(snap.boxes.get("ruby-dev")!.builtin).toBeUndefined();
    await sync([stored("ruby-dev", "b"), stored("default", "c")]);
    const own = (await boxSnapshot(T, db)).boxes.get("default")!;
    expect(own.builtin).toBeUndefined();
    expect(own.current.image).toBe(`ghcr.io/example/boxes/default@${digest("c")}`);
    // A digest only the built-in had is not a version of the stored box.
    expect(await pinnedBox(T, "default", digest("a"), db)).toBeNull();
  });

  test("a stored set that does not verify fails closed: the built-in is not a fallback", async () => {
    use("a");
    await sync([stored("ruby-dev", "b")]);
    await db.run(`UPDATE box_versions SET digest = ? WHERE tenant_id = ? AND name = 'ruby-dev'`, [digest("f"), T]);
    __resetBoxRegistryForTests();
    await expect(loadBoxes(T, db)).rejects.toBeInstanceOf(BoxIntegrityError);
    await expect(currentBox(T, "default", db)).rejects.toBeInstanceOf(BoxIntegrityError);
    await expect(pinnedBox(T, "default", digest("a"), db)).rejects.toBeInstanceOf(BoxIntegrityError);
  });

  test("a session pinned to an earlier release's digest keeps that digest: same repository, current policy, not stale", async () => {
    use("b");
    const old = (await pinnedBox(T, "default", digest("a"), db))!;
    expect(old.image).toBe(ref("a"));
    expect(old.digest).toBe(digest("a"));
    expect(old.stale).toBe(false);
    expect(old.policy).toEqual((await currentBox(T, "default", db))!.policy);
    expect(await isStale({ tenant: T }, { name: "default", digest: digest("a") }, { pinned: (t, n, d) => pinnedBox(t, n, d, db) })).toBe(false);
    const cur = (await pinnedBox(T, "default", digest("b"), db))!;
    expect([cur.image, cur.stale]).toEqual([ref("b"), false]);
    // Not a digest, or a stand-in: no version.
    expect(await pinnedBox(T, "default", "sha256:zz", db)).toBeNull();
    expect(await pinnedBox(T, "default", standInDigestFor("c".repeat(64)), db)).toBeNull();
    const entry = (await boxSnapshot(T, db)).boxes.get("default")!;
    expect(versionAt(entry, digest("b"))).toBe(entry.current);
  });

  test("it moves only by a refresh, which writes the audit row; a shipped box.yaml that forces makes older pins stale", async () => {
    use("b");
    let pin = { name: "default", digest: digest("a") };
    const audits: Array<{ action: string; details?: unknown }> = [];
    const deps: BoxRefreshDeps = {
      read: async () => pin,
      current: (t, n) => currentBox(t, n, db),
      pinned: (t, n, d) => pinnedBox(t, n, d, db),
      turnInFlight: async () => false,
      setDigest: async (_s, _n, from, to) => (pin.digest === from ? ((pin = { ...pin, digest: to }), true) : false),
      reload: () => {},
      mark: async () => {},
      audit: ((e: { action: string; details?: unknown }) => void audits.push(e)) as never,
    };
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const r = await refresh({ tenant: T, persona: "ana", sessionId: "builtin-s1" }, { by: { kind: "user", userId: "U1" } }, deps);
      expect(r).toMatchObject({ status: "refreshed", box: "default", from: digest("a"), to: digest("b"), version: 0 });
    } finally {
      log.mockRestore();
    }
    expect(pin.digest).toBe(digest("b"));
    expect(audits.map((a) => a.action)).toEqual(["box.refreshed"]);
    expect(audits[0]!.details).toMatchObject({ box: "default", from: digest("a"), to: digest("b") });

    const forcing = readFileSync(join(shipped, "box.yaml"), "utf8") + "refresh:\n  force: true\n";
    __setBuiltinBoxDirForTests(imageDir(bothArch("b"), forcing));
    __resetBoxRegistryForTests();
    expect((await pinnedBox(T, "default", digest("a"), db))!.stale).toBe(true);
    expect((await pinnedBox(T, "default", digest("b"), db))!.stale).toBe(false);
  });

  test("GET /v1/node/boxes lists it for a label whose persona uses it, with the older digests sessions are pinned to", async () => {
    use("b");
    const snapshot = (t: string) => boxSnapshot(t, db);
    const personas = () => [{ label: "default", box: "default" }, { label: "finance", box: null }];
    const pinned = async () => [{ name: "default", digest: digest("a") }, { name: "default", digest: digest("b") }, { name: "default", digest: "sha256:nope" }];
    const r = await boxesForLabels(new Set(["default"]), T, { personas, snapshot, pinned });
    expect(r.boxes).toEqual([
      { name: "default", image: ref("b"), digest: digest("b"), current: true },
      { name: "default", image: ref("a"), digest: digest("a"), current: false },
    ]);
    expect((await boxesForLabels(new Set(["finance"]), T, { personas, snapshot, pinned })).boxes).toEqual([]);
    use(null);
    __resetBoxRegistryForTests();
    expect((await boxesForLabels(new Set(["default"]), T, { personas, snapshot, pinned })).boxes).toEqual([]);
  });

  describe("slaude box digests --in-use", () => {
    const session = (id: string, name: string | null, d: string | null) =>
      db.run(
        `INSERT INTO sessions (id, created_at, updated_at, model, working_dir, slack_team_id, slack_channel_id, slack_thread_ts, box_name, box_digest) VALUES (?, 1, 1, 'm', '/w', 'T0EXAMPLE', 'C0EXAMPLE', ?, ?, ?)`,
        [id, `${id}.1`, name, d],
      );

    test("nothing stored, no built-in: nothing", async () => {
      expect(await digestsInUse(db)).toEqual({ images: [], unresolved: 0 });
    });

    test("every stored version of every tenant, old ones included, sorted and unique", async () => {
      await sync([stored("ruby-dev", "a")]);
      await sync([stored("ruby-dev", "b")]);
      await sync([stored("py-dev", "a")], "t2");
      await session("builtin-d1", "ruby-dev", digest("a"));
      await session("builtin-d2", null, null);
      expect(await digestsInUse(db)).toEqual({
        images: [`ghcr.io/example/boxes/py-dev@${digest("a")}`, `ghcr.io/example/boxes/ruby-dev@${digest("a")}`, `ghcr.io/example/boxes/ruby-dev@${digest("b")}`],
        unresolved: 0,
      });
    });

    test("the command: needs --in-use, refuses to run on a node, and prints nothing where nothing is stored", async () => {
      const home = mkdtempSync(join(tmpdir(), "builtin-box-home-"));
      made.push(home);
      const runCli = async (args: string[], env: Record<string, string> = {}) => {
        const { SLAUDE_DB: _d, SLAUDE_PG_URL: _u, DATABASE_URL: _p, SLAUDE_ROLE: _r, ...rest } = process.env;
        const p = Bun.spawn(["bun", "--no-env-file", join(root, "src/cli/box.ts"), ...args], { stdout: "pipe", stderr: "pipe", env: { ...rest, SLAUDE_HOME: home, ...env } });
        const [out, errText, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
        return { out, errText, code };
      };
      const usage = await runCli(["digests"]);
      expect(usage.code).toBe(2);
      expect(usage.errText).toContain("slaude box digests --in-use");
      const node = await runCli(["digests", "--in-use"], { SLAUDE_ROLE: "node" });
      expect(node.code).toBe(1);
      expect(node.errText).toContain("runs on the gateway or mono host");
      const empty = await runCli(["digests", "--in-use"]);
      expect(empty.code).toBe(0);
      expect(empty.out.split("\n").filter((l) => l.includes("@sha256:"))).toEqual([]);
    }, 30_000);

    test("the built-in's images of every architecture, and the older built-in digests sessions are pinned to", async () => {
      const builtin = readBuiltinBox(imageDir(bothArch("b", "c")), "amd64")!;
      await session("builtin-d3", "default", digest("a"));
      await session("builtin-d4", "default", digest("b"));
      await session("builtin-d5", "gone", digest("e"));
      expect(await digestsInUse(db, { builtin })).toEqual({ images: [ref("a"), ref("b"), ref("c")], unresolved: 1 });
      // Without a built-in the pin of `default` has no repository either.
      expect(await digestsInUse(db)).toEqual({ images: [], unresolved: 3 });
    });

    test("a stored `default` owns its name: a pin of it is never placed in the built-in's repository", async () => {
      const builtin = readBuiltinBox(imageDir(bothArch("b")), "amd64")!;
      await sync([stored("default", "c")]);
      await session("builtin-d6", "default", digest("a"));
      expect(await digestsInUse(db, { builtin })).toEqual({ images: [`ghcr.io/example/boxes/default@${digest("c")}`, ref("b")], unresolved: 1 });
    });
  });
});
