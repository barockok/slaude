import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "slaude-brainlock-"));
process.env.SLAUDE_BRAIN_HOME = home;

// Simulate the k8s restart trap: a lock left by a previous pod whose PID is
// alive in THIS process namespace (we use our own pid — guaranteed alive and
// not the engine). Without takeover, connect would block 60s then throw.
const lockDir = join(home, "db", ".gbrain-lock");
mkdirSync(lockDir, { recursive: true });
writeFileSync(join(lockDir, "lock"), JSON.stringify({ pid: process.pid, ts: Date.now() }));

import { getBrain, closeBrain } from "../src/knowledge/brain";

afterAll(async () => {
  await closeBrain();
  delete process.env.SLAUDE_BRAIN_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("brain boot lock takeover", () => {
  test("clears a leftover PGLite lock and boots", async () => {
    await getBrain(); // would time out without takeover
    expect(true).toBe(true);
  }, 90_000);

  test("clears stale gbrain_cycle_locks rows (sync/dream locks) on boot", async () => {
    // Simulate a sync lock left by a dead pod: row with foreign host + live-ish
    // pid, future TTL — gbrain would refuse the lock for up to 30 minutes.
    const engine = (await getBrain()) as unknown as {
      db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
    };
    await engine.db.query(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
       VALUES ('gbrain-sync:default', $1, 'dead-pod-abc', NOW(), NOW() + INTERVAL '30 minutes', NOW())`,
      [process.pid],
    );
    await closeBrain();
    await getBrain(); // re-boot same home — takeover must clear the row
    const fresh = (await getBrain()) as unknown as {
      db: { query: (sql: string) => Promise<{ rows: unknown[] }> };
    };
    const { rows } = await fresh.db.query("SELECT id FROM gbrain_cycle_locks");
    expect(rows.length).toBe(0);
  }, 90_000);
});
