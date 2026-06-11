// One-shot operator command: import historical sqlite memory_turns into the
// brain, then embed stale chunks if the embedding gateway is active.
//
//   bun run brain-backfill            # backfill + embed sweep
//   bun run brain-backfill --no-embed # backfill only
//
// Idempotent — safe to re-run. Run inside the deploy (pod terminal) so it
// sees the real $SLAUDE_HOME / brain PVC. Do NOT run while another slaude
// process is mid-sync; boot lock takeover assumes single ownership.
import { backfillMemoryTurns, embedStaleChunks } from "../knowledge/brain-backfill";
import { ensureSources, closeBrain } from "../knowledge/brain";

const log = (m: string) => console.log(m);

console.log("[backfill] ensuring brain sources…");
await ensureSources();
console.log("[backfill] importing memory_turns…");
const r = await backfillMemoryTurns(log);
console.log(`[backfill] done: ${r.sessions} sessions, ${r.turns} turns, ${r.errors} error(s)`);
if (!process.argv.includes("--no-embed")) {
  await embedStaleChunks(log);
}
await closeBrain();
process.exit(r.errors ? 1 : 0);
