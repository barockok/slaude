import { afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Import-free module: safe to load before SLAUDE_HOME is set below.
import { settleBrainWork, whileClosing } from "../src/knowledge/brain-work";

// Isolate every test run under a fresh $SLAUDE_HOME so db/schema bootstrap and
// soul/loader writes don't touch the operator's real ~/.slaude.
const home = mkdtempSync(join(tmpdir(), "slaude-test-"));
process.env.SLAUDE_HOME = home;
// Set CLAUDE_CONFIG_DIR to the temp home's .claude dir so agentConfigDir() returns
// a test-controlled path (not the real ~/.claude) and test isolation holds.
process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");

// Seed a .env file in the test home so loadDotenv has something to parse on
// first import of config/env. Covers the quoted-value / dedup branches.
writeFileSync(
  join(home, ".env"),
  [
    'SLAUDE_TEST_QUOTED="hello"',
    "SLAUDE_TEST_SINGLE='world'",
    "SLAUDE_TEST_PLAIN=plain",
    "# comment line — ignored",
    "ALSO IGNORED",
    "",
  ].join("\n"),
);

process.env.SLAUDE_APPROVERS = "";
process.env.SLAUDE_HEALTH_PORT = "0";
process.env.SLAUDE_DEFAULT_MODE = "default";
// Prevent leaked CLAUDE_CODE_OAUTH_TOKEN from operator shell affecting tests.
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

// Every createGateway() starts the brain's boot-time source bootstrap and KB
// import in the background. Many tests never stop their gateway, and all test
// files share one process, so that work used to run on into later tests and
// files: event-loop stalls that tripped 5s hook timeouts, gbrain sync lock
// contention, and a later closeBrain() disconnecting the engine under it.
// Drain it after every test (as a close would: the import stops between KBs).
// A no-op when nothing is in flight. The timeout covers a first brain boot.
afterEach(() => whileClosing(settleBrainWork), 60_000);

// Real-PG leg only: unlike the sqlite/PGLite legs (fresh store per run), the
// test Postgres persists across runs while most tests emit deterministic
// event ids, thread ts values and gate tokens. Durable rows from a previous
// run then poison a rerun — seen_events claims lose (events silently
// dedup-dropped), leftover ignores/locks swallow fixture threads, stale
// sessions/crons leak into scheduler and engagement paths. Wipe the volatile
// runtime tables up front, guarded to the case where the run is explicitly
// pointed at the disposable test database (SLAUDE_PG_URL === the TEST url).
const pgTest = process.env.SLAUDE_PG_TEST_URL;
if (pgTest && process.env.SLAUDE_DB === "pg" && process.env.SLAUDE_PG_URL === pgTest) {
  const { SQL } = await import("bun");
  const sql = new SQL(pgTest);
  // Children before parents (memory_* reference sessions). Each delete is
  // independent: on a fresh database the tables appear only when the first
  // test boots migrations, so missing relations are fine.
  for (const table of [
    "memory_turns",
    "memory_facts",
    "pending_gates",
    "seen_events",
    "ignores",
    "cron_jobs",
    "one_on_one_locks",
    "remote_targets",
    "remote_keys",
    "mention_only_threads",
    "soul_overrides",
    "sessions",
  ]) {
    try {
      await sql.unsafe(`DELETE FROM ${table}`);
    } catch {
      // Fresh database — table not created yet.
    }
  }
  await sql.end();
}
