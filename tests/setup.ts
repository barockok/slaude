import { afterAll, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Import-free module: safe to load before SLAUDE_HOME is set below.
import { settleBrainWork, whileClosing } from "../src/knowledge/brain-work";
import { stopRunningLoops } from "../src/gateway/core/running-loops";
// Import-free too: waits for fire-and-forget domain-record writes (first sight).
import { flushFirstSightWork } from "../src/domain/first-sight-flush";

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
// Prevent leaked credentials/embedding config from operator shell affecting tests.
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
delete process.env.EMBEDDING_PROVIDER;
delete process.env.EMBEDDING_MODEL;
delete process.env.EMBEDDING_DIMENSIONS;

// Every createGateway() starts the brain's boot-time source bootstrap and KB
// import in the background. Many tests never stop their gateway, and all test
// files share one process, so that work used to run on into later tests and
// files: event-loop stalls that tripped 5s hook timeouts, gbrain sync lock
// contention, and a later closeBrain() disconnecting the engine under it.
// Drain it after every test (as a close would: the import stops between KBs).
// A no-op when nothing is in flight. The timeout covers a first brain boot.
afterEach(() => whileClosing(settleBrainWork), 60_000);
// Same for poll loops: each gateway starts a cron scheduler (a 60s interval on
// the shared DB facade). One left running by a gateway nobody stopped polled
// into later files, e.g. while facade.test pointed the facade at an
// unmigrated PGLite. Stop any still running after each test.
afterEach(() => stopRunningLoops());
// First sight writes records fire-and-forget (session create, audit). Settle them
// after each test so none lands after a wipe or a closed database in the next one.
afterEach(() => flushFirstSightWork());

// Access shadows run detached. Settle them after each test, and drop the actor and lookup
// caches and the mismatch log map, so no shadow, cached actor or log throttle leaks into the next test.
afterEach(async () => {
  const { settleShadows } = await import("../src/access/wired");
  await settleShadows();
  (await import("../src/refs/actor")).invalidateActors();
  (await import("../src/access/decide")).__resetDecide();
});

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

// CI diagnostics, real Postgres only (SLAUDE_PG_TEST_URL set): a hook that waits on the database for
// longer than a second is almost always a lock wait or an idle-in-transaction connection left by an
// earlier test in this process. A watchdog on its own small connection prints who waits for whom
// (at most 6 dumps per process), so a failing job explains itself.
if (pgTest && process.env.SLAUDE_DB === "pg" && process.env.SLAUDE_PG_URL === pgTest) {
  const { SQL } = await import("bun");
  const watch = new SQL({ url: pgTest, max: 1 });
  let dumps = 0;
  let last = 0;
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || dumps >= 6) return;
    busy = true;
    try {
      const sus = (await watch.unsafe(
        `SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND ((wait_event_type = 'Lock' AND now() - query_start > interval '1 second')
              OR (state LIKE 'idle in transaction%' AND now() - state_change > interval '2 seconds'))`,
      )) as Array<{ pid: number }>;
      if (sus.length && Date.now() - last > 4000) {
        last = Date.now();
        dumps++;
        const act = await watch.unsafe(
          `SELECT pid, state, wait_event_type, wait_event, now() - xact_start AS xact_age, now() - query_start AS q_age,
                  pg_blocking_pids(pid) AS blocked_by, left(query, 200) AS query
             FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() ORDER BY query_start`,
        );
        const locks = await watch.unsafe(
          `SELECT l.pid, l.locktype, l.mode, l.granted, c.relname
             FROM pg_locks l LEFT JOIN pg_class c ON c.oid = l.relation
            WHERE l.pid <> pg_backend_pid() AND (NOT l.granted OR l.pid IN (SELECT unnest(pg_blocking_pids(pid)) FROM pg_stat_activity WHERE datname = current_database()))`,
        );
        console.log(`[pg-diag] waiting backends (dump ${dumps}): ${JSON.stringify(act)}\n[pg-diag] locks: ${JSON.stringify(locks)}`);
      }
    } catch (e) {
      console.log(`[pg-diag] watchdog error: ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  }, 1000);
  (timer as { unref?: () => void }).unref?.();
  // End of the run: stop the timer and give the connection back.
  afterAll(async () => {
    clearInterval(timer);
    await watch.close().catch(() => {});
  });
}
