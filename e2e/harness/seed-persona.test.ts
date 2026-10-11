// Runs the in-pod persona seed on the host, the closest thing to a gateway pod available
// locally: a child `bun` with the image's /app/src imports resolved to this repo's src/, a temp
// $SLAUDE_HOME, a separate temp SLAUDE_SOUL_CACHE_DIR, a master key and an in-process Postgres
// (PGLite, for the slack_apps registry). A second child then reads the soul through the real
// loadSoulData() with the LLM endpoint unreachable, as a gateway does at boot.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const SEED = join(REPO, "e2e", "harness", "in-pod", "seed-persona.ts");
const KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");

let tmp: string;
let home: string;
let cacheDir: string;
let preload: string;
let verifier: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "slaude-seed-"));
  home = join(tmp, "home");
  mkdirSync(home); // a pod's $SLAUDE_HOME always exists
  cacheDir = join(tmp, "soul-cache");
  preload = join(tmp, "app-src.ts");
  writeFileSync(
    preload,
    `Bun.plugin({ name: "app-src", setup(b) {
  b.onResolve({ filter: /^\\/app\\/src\\// }, (a) => ({ path: ${JSON.stringify(join(REPO, "src"))} + a.path.slice("/app/src".length) }));
} });\n`,
  );
  verifier = join(tmp, "verify.ts");
  writeFileSync(
    verifier,
    `import { loadSoulData } from ${JSON.stringify(join(REPO, "src", "soul", "extract.ts"))};
const d = await loadSoulData();
console.log("RESULT " + JSON.stringify({ manager: d.manager.userId ?? "" }));\n`,
  );
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(SLAUDE_|ANTHROPIC_|CLAUDE_CODE_)/.test(k)) continue;
    env[k] = v;
  }
  return {
    ...env,
    SLAUDE_HOME: home,
    SLAUDE_SOUL_CACHE_DIR: cacheDir,
    SLAUDE_MASTER_KEY: KEY,
    SLAUDE_DB: "pg",
    SLAUDE_PGLITE_DIR: join(tmp, "pglite"),
    // Any extraction attempt fails fast: only a cache hit can produce the manager.
    ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
    ANTHROPIC_API_KEY: "unused",
    ...extra,
  };
}

function seed(extra: Record<string, string> = { SLAUDE_E2E_SEED: "1" }) {
  const r = Bun.spawnSync(
    ["bun", "--preload", preload, SEED,
      "--persona-id", "alpha", "--api-app-id", "A0ALPHA", "--team-id", "T0TEAM",
      "--bot-token", "bot-token-alpha", "--signing-secret", "secret-alpha", "--bot-user-id", "U0ALPHA"],
    { cwd: REPO, env: childEnv(extra), timeout: 45_000 },
  );
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

function verify(extra: Record<string, string> = {}): string {
  const r = Bun.spawnSync(["bun", verifier], { cwd: tmp, env: childEnv(extra), timeout: 45_000 });
  const line = r.stdout.toString().split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) throw new Error(`verifier printed no result: ${r.stdout}${r.stderr}`);
  return JSON.parse(line.slice("RESULT ".length)).manager;
}

const entries = () => readdirSync(cacheDir).filter((f) => /^soul\.[0-9a-f]{16}\.json$/.test(f));

test("without SLAUDE_E2E_SEED=1 the seed refuses and writes nothing", () => {
  const r = seed({});
  expect(r.code).toBe(1);
  expect(r.out).toContain("set SLAUDE_E2E_SEED=1");
  expect(existsSync(join(home, "SOUL.md"))).toBe(false);
  expect(existsSync(cacheDir)).toBe(false);
}, 60_000);

test("the seed writes a signed entry into SLAUDE_SOUL_CACHE_DIR and its self-check hits it", () => {
  const r = seed();
  expect(r.out).toContain("soul cache hit at");
  expect(r.code).toBe(0);
  expect(readFileSync(join(home, "SOUL.md"), "utf8")).toMatch(/^Persona-ID: alpha$/m);
  expect(entries()).toHaveLength(1);
  const body = JSON.parse(readFileSync(join(cacheDir, entries()[0]!), "utf8"));
  expect(body.v).toBe(1);
  expect(body.mac).toMatch(/^[0-9a-f]{64}$/);
  expect(body.data.manager.userId).toBe("U0MGR");
  // Not the $SLAUDE_HOME default: the override is honoured.
  expect(existsSync(join(home, "cache"))).toBe(false);
}, 60_000);

test("a gateway process with the same key and directory reads the seeded manager with no LLM", () => {
  expect(verify()).toBe("U0MGR");
}, 60_000);

test("a process with another master key rejects the entry (it is signed, not plain)", () => {
  expect(verify({ SLAUDE_MASTER_KEY: OTHER_KEY })).toBe("");
}, 60_000);

test("a process reading another directory does not see the entry", () => {
  expect(verify({ SLAUDE_SOUL_CACHE_DIR: join(tmp, "elsewhere") })).toBe("");
}, 60_000);

test("an unsigned plain entry, the seed's former format, is rejected under a master key", () => {
  const file = join(cacheDir, entries()[0]!);
  const signed = readFileSync(file, "utf8");
  writeFileSync(file, JSON.stringify(JSON.parse(signed).data, null, 2));
  try {
    expect(verify()).toBe("");
  } finally {
    writeFileSync(file, signed);
  }
  expect(verify()).toBe("U0MGR");
}, 60_000);

test("a re-run replaces its own soul and the entry stays the one extraction accepts", () => {
  const soulBefore = readFileSync(join(home, "SOUL.md"), "utf8");
  const entryBefore = readFileSync(join(cacheDir, entries()[0]!), "utf8");
  const r = seed();
  expect(r.out).toContain("replacing a SOUL.md of kind 'e2e'");
  expect(r.code).toBe(0);
  expect(entries()).toHaveLength(1);
  // Byte-identical, so the driver's boot fingerprint is unchanged and a re-run restarts nothing.
  expect(readFileSync(join(home, "SOUL.md"), "utf8")).toBe(soulBefore);
  expect(readFileSync(join(cacheDir, entries()[0]!), "utf8")).toBe(entryBefore);
  expect(verify()).toBe("U0MGR");
}, 60_000);

// Last: it leaves the tenant managed.
test("once the tenant is managed by personas as code the seed refuses and changes nothing", () => {
  const sync = join(tmp, "sync.ts");
  writeFileSync(
    sync,
    `import { applySync } from ${JSON.stringify(join(REPO, "src", "db", "personas.ts"))};
await applySync("default", [{ name: "default", slackUserId: null, userToken: null, model: null, soulMd: "synced",
  soulJson: { approvers: [] }, mcp: null, origin: "git", tombstonedAt: null }],
  { revision: "r1", committedAt: Date.parse("2026-10-01T10:00:00Z"), by: "test" });
process.exit(0);\n`,
  );
  const s = Bun.spawnSync(["bun", sync], { cwd: tmp, env: childEnv({}), timeout: 45_000 });
  expect(s.exitCode).toBe(0);
  const soulBefore = readFileSync(join(home, "SOUL.md"), "utf8");
  const entryBefore = readFileSync(join(cacheDir, entries()[0]!), "utf8");
  const r = seed();
  expect(r.out).toContain("managed by personas as code");
  expect(r.code).toBe(1);
  expect(readFileSync(join(home, "SOUL.md"), "utf8")).toBe(soulBefore);
  expect(readFileSync(join(cacheDir, entries()[0]!), "utf8")).toBe(entryBefore);
}, 60_000);
