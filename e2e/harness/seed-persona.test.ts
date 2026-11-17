// Runs the in-pod persona seed on the host, the closest thing to a gateway pod available
// locally: a child `bun` with the image's /app/src imports resolved to this repo's src/, a temp
// $SLAUDE_HOME and an in-process Postgres (PGLite, for the slack_apps registry). The seed writes
// an agent.yaml, which the gateway reads at boot with no model call.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STARTER_AGENT_YAML } from "../../src/persona/disk-check";
import { readFileAgent } from "../../src/persona/file-agent";

const REPO = join(import.meta.dir, "..", "..");
const SEED = join(REPO, "e2e", "harness", "in-pod", "seed-persona.ts");
// slack-app add encrypts the registered credentials with this.
const KEY = Buffer.alloc(32, 7).toString("base64");

let tmp: string;
let home: string;
let preload: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "slaude-seed-"));
  home = join(tmp, "home");
  mkdirSync(home); // a pod's $SLAUDE_HOME always exists
  preload = join(tmp, "app-src.ts");
  writeFileSync(
    preload,
    `Bun.plugin({ name: "app-src", setup(b) {
  b.onResolve({ filter: /^\\/app\\/src\\// }, (a) => ({ path: ${JSON.stringify(join(REPO, "src"))} + a.path.slice("/app/src".length) }));
} });\n`,
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
    SLAUDE_MASTER_KEY: KEY,
    SLAUDE_DB: "pg",
    SLAUDE_PGLITE_DIR: join(tmp, "pglite"),
    // No model is involved: nothing may reach one.
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

const agentFile = () => join(home, "agent.yaml");

test("without SLAUDE_E2E_SEED=1 the seed refuses and writes nothing", () => {
  const r = seed({});
  expect(r.code).toBe(1);
  expect(r.out).toContain("set SLAUDE_E2E_SEED=1");
  expect(existsSync(agentFile())).toBe(false);
}, 60_000);

test("the seed writes an agent.yaml the gateway reads: the manager, the channels, the Persona-ID line", () => {
  const r = seed();
  expect(r.out).toContain("agent.yaml written at");
  expect(r.code).toBe(0);
  const a = readFileAgent(home, "default")!;
  expect(a.soulJson.manager.userId).toBe("U0MGR");
  expect(a.soulJson.backupManager.userId).toBe("U0BACKUP");
  expect(a.soulJson.trustedChannels).toEqual(["C0TEAM"]);
  expect(a.soulJson.allowedChannels).toEqual(["C0PUB"]);
  expect(a.soulJson.approvers.map((x) => x.userId)).toEqual(["U0APP"]);
  expect(readFileSync(agentFile(), "utf8")).toMatch(/Persona-ID: alpha/);
  expect(a.warnings).toEqual([]);
}, 60_000);

test("a re-run is byte-identical and says what it replaced", () => {
  const before = readFileSync(agentFile(), "utf8");
  const r = seed();
  expect(r.out).toContain("replacing an agent.yaml of kind 'e2e'");
  expect(r.code).toBe(0);
  // Identical, so the driver's boot fingerprint is unchanged and a re-run restarts nothing.
  expect(readFileSync(agentFile(), "utf8")).toBe(before);
}, 60_000);

test("a SOUL.md left in the home is removed: the gateway refuses a home that has both", () => {
  writeFileSync(join(home, "SOUL.md"), "# leftover");
  const r = seed();
  expect(r.code).toBe(0);
  expect(existsSync(join(home, "SOUL.md"))).toBe(false);
}, 60_000);

test("the gateway's untouched starter is replaced, an operator's agent.yaml is not", () => {
  writeFileSync(agentFile(), STARTER_AGENT_YAML);
  expect(seed().out).toContain("kind 'starter'");
  writeFileSync(agentFile(), "name: default\nsoul: mine\n");
  const refused = seed();
  expect(refused.code).toBe(1);
  expect(refused.out).toContain("SLAUDE_E2E_SEED_FORCE=1");
  expect(readFileSync(agentFile(), "utf8")).toBe("name: default\nsoul: mine\n");
}, 90_000);

// Last: it leaves the tenant managed.
test("once the tenant is managed by personas as code the seed refuses and changes nothing", () => {
  writeFileSync(agentFile(), "name: default\nsoul: |\n  Sim agent.\n  Persona-ID: alpha\n");
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
  const before = readFileSync(agentFile(), "utf8");
  const r = seed();
  expect(r.out).toContain("managed by personas as code");
  expect(r.code).toBe(1);
  expect(readFileSync(agentFile(), "utf8")).toBe(before);
}, 60_000);
