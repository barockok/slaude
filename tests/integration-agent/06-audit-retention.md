# 06: audit retention

## Purpose

`audit_events` is append-only at the code level: insert and a retention purge
are the only write paths. The purge deletes rows older than
`SLAUDE_AUDIT_RETENTION_DAYS` days (default 365; a value below 1 or not an
integer falls back to 365). It runs on the gateway's housekeeping interval,
every 5 minutes, next to the `pending_gates` purge; there is no purge at boot.
Because ids start with the zero-padded epoch ms, the purge is an id range
(`DELETE FROM audit_events WHERE id < <timeKey(now - retention)>`).

Code: `src/config/env.ts` (`auditRetentionDays`), `src/db/audit-events.ts`
(`purgeOlderThan`, `timeKey`), `src/gateway/core/gateway.ts` (the
`setInterval(..., 5 * 60 * 1000)` housekeeping block).

## Setup

- Unit floor: `bun test tests/audit/audit.test.ts` (covers `purgeOlderThan`).
- Environment A's database (`$SLAUDE_DB_PATH`, schema created by the
  bootstrap transcript). No other process may hold it during this scenario.
- A helper that boots the sim gateway (stub agent, the same `createGateway`
  as production) and keeps it alive past one housekeeping tick:

```sh
cat > "$IT/hold-gateway.ts" <<EOF
// Boots the sim gateway and keeps it alive so its 5-minute housekeeping interval runs once.
const holdMs = Number(process.env.HOLD_MS ?? 330_000);
const { SimSession } = await import("$REPO/src/gateway/sim/engine.ts");
const s = await SimSession.create({ agent: "stub" });
console.log(\`[hold] gateway up; holding \${holdMs} ms\`);
await new Promise((r) => setTimeout(r, holdMs));
await s.dispose();
console.log("[hold] done");
process.exit(0);
EOF
```

## Steps

1. Run the unit floor.
2. Seed three rows: one at epoch 1 ms, one two days old, one fresh.

```sh
NOWMS=$(( $(date +%s) * 1000 ))
sqlite3 "$SLAUDE_DB_PATH" "DELETE FROM audit_events;
INSERT INTO audit_events (id, persona, at, actor_kind, actor_id, action, summary, details)
  VALUES ('0000000000001-000000000001', 'default', 1, 'system', 'system', 'it.retention.old', 'integration test: epoch', '{}');
INSERT INTO audit_events (id, persona, at, actor_kind, actor_id, action, summary, details)
  VALUES (printf('%013d-000000000002', $NOWMS - 2*86400000), 'default', $NOWMS - 2*86400000, 'system', 'system', 'it.retention.old', 'integration test: two days old', '{}');
INSERT INTO audit_events (id, persona, at, actor_kind, actor_id, action, summary, details)
  VALUES (printf('%013d-000000000003', $NOWMS), 'default', $NOWMS, 'system', 'system', 'it.retention.fresh', 'integration test: fresh', '{}');"
sqlite3 "$SLAUDE_DB_PATH" "SELECT id, action FROM audit_events ORDER BY id;"
```

3. Boot and hold with a 1-day retention (takes 5.5 minutes; run it in the
   background and poll the log):

```sh
SLAUDE_HOME="$(mktemp -d)" SLAUDE_HEALTH_PORT=0 SLAUDE_BRAIN_DISABLED=1 \
  SLAUDE_AUDIT_RETENTION_DAYS=1 bun "$IT/hold-gateway.ts" > "$IT/hold.log" 2>&1 &
until grep -q '\[hold\] done' "$IT/hold.log"; do sleep 15; done
```

4. After `[hold] done` appears in `$IT/hold.log`:
   `sqlite3 "$SLAUDE_DB_PATH" "SELECT id, action FROM audit_events ORDER BY id;"`
5. Default retention keeps a two-day-old row: re-seed as in step 2, then run
   step 3 without `SLAUDE_AUDIT_RETENTION_DAYS` (or with `=abc`, which falls
   back to 365), and repeat step 4.
6. Optional, environment B (default retention, 365 days; changing it means
   restarting the gateway with the new value in its environment). Seed an old row with
   `psqlq "INSERT INTO audit_events (id, at, actor_kind, actor_id, action) VALUES ('0000000000001-0000000000ff', 1, 'system', 'system', 'it.retention.old');"`,
   wait 5 to 6 minutes after the gateway's start time (`gateway.log` first
   line), and check `psqlq "SELECT COUNT(*) FROM audit_events WHERE action='it.retention.old';"`.

## Expected observations

1. Passes.
2. Three rows: `0000000000001-000000000001|it.retention.old`,
   `<13 digits>-000000000002|it.retention.old`, `<13 digits>-000000000003|it.retention.fresh`.
3. `$IT/hold.log` shows `[hold] gateway up; holding 330000 ms`, then about 5.5
   minutes later `[hold] done`.
4. Only `<13 digits>-000000000003|it.retention.fresh` remains (both old rows
   purged by the first housekeeping tick).
5. With the default 365 days, the epoch row is purged and the two-day-old and
   fresh rows remain.
6. `0`.

## Cleanup

`sqlite3 "$SLAUDE_DB_PATH" "DELETE FROM audit_events WHERE action LIKE 'it.retention.%';"`
(and the same with `psqlq` for step 6). These are test rows; real audit rows
are never deleted by hand.

## Notes

- Steps 2 to 4 were run once while writing this file and passed as described
  (the epoch row and the two-day-old row were gone after the hold, the fresh
  one stayed).
- The first tick is 5 minutes after the gateway starts, not at boot; a
  shorter hold proves nothing. `HOLD_MS` can be raised if the machine is slow.
- A purge failure is swallowed (`.catch(() => {})`) and does not increment a
  metric; only the gateway's behaviour (rows gone or not) is observable.
