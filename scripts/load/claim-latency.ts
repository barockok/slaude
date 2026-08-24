/**
 * Queue claim-latency load smoke (spec §8 load leg, in-process variant).
 *
 * Boots the multi-node sim cluster — role=gateway dispatch + N node workers
 * with the stub agent — against REAL Redis (SLAUDE_REDIS_URL required; DB per
 * SLAUDE_DB/SLAUDE_PG_URL), then fires `--threads` concurrent DM threads
 * (`--per-thread` messages each) through the Slack surface and measures the
 * per-job queue claim latency (enqueuedAt → worker claim), the exact metric
 * spec §8 budgets: p95 under 500ms at 200 concurrent threads.
 *
 *   SLAUDE_REDIS_URL=redis://localhost:6379 bun scripts/load/claim-latency.ts \
 *     --threads 200 --per-thread 1 --nodes 2 --concurrency 100 --p95-ms 500
 *
 * Default worker concurrency (2×100) covers the 200-thread burst: the budget
 * measures QUEUE CLAIM OVERHEAD, so capacity must match the offered load —
 * with fewer slots the p95 measures backlog wait (a capacity decision), not
 * the queue layer. Local baseline: p95 ≈ 325ms at 200 threads.
 *
 * Exit 1 when the p95 threshold is breached (or turns don't finish in time).
 * The k6 variant (scripts/load/k6-turns.js) drives the same load through the
 * real HTTP ingress of a compose stack instead; this script is the CI-friendly
 * form — no image build, and the claim latency is sampled directly instead of
 * scraped from a last-value gauge.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i === -1 ? NaN : Number.parseInt(process.argv[i + 1] ?? "", 10);
  return Number.isInteger(v) && v > 0 ? v : dflt;
}
const THREADS = arg("threads", 200);
const PER_THREAD = arg("per-thread", 1);
const NODES = arg("nodes", 2);
const CONCURRENCY = arg("concurrency", 100);
const P95_MS = arg("p95-ms", 500);
const DEADLINE_MS = arg("deadline-ms", 180_000);

// Isolated home BEFORE any config-dependent import (mirrors sim cli.ts).
process.env.SLAUDE_HOME = mkdtempSync(join(tmpdir(), "slaude-load-"));
process.env.SLAUDE_HEALTH_PORT = "0";
process.env.SLAUDE_BRAIN_DISABLED = "1";
process.env.SLACK_BOT_TOKEN ??= "xoxb-load";

const { ensureHome } = await import("../../src/config/home");
ensureHome();
const { writeSoulFixture, WORLD } = await import("../../src/gateway/sim/soul-fixture");
writeSoulFixture(WORLD);

const { SimTransport } = await import("../../src/gateway/sim/transport");
const { startSimCluster } = await import("../../src/gateway/sim/cluster");
const { m: metric } = await import("../../src/metrics");

// Sample every claim latency: the worker publishes it into a last-value
// gauge; wrap the setter to keep the full distribution.
const samplesSec: number[] = [];
const gauge: any = metric.nodeClaimLatency;
const origSet = gauge.set.bind(gauge);
gauge.set = (v: number) => {
  samplesSec.push(v);
  return origSet(v);
};

const transport = new SimTransport({ users: { U0MGR: "Manager" } });
const cluster = await startSimCluster({ nodes: NODES, transport, worker: { concurrency: CONCURRENCY } });

const expectReplies = THREADS * PER_THREAD;
const replies = () => transport.outbound.filter((c) => c.kind === "message" && c.text?.includes("ack: done")).length;

console.log(`[load] ${THREADS} threads × ${PER_THREAD} msg — ${NODES} nodes, concurrency ${CONCURRENCY}`);
const t0 = Date.now();
for (let round = 0; round < PER_THREAD; round++) {
  await Promise.all(
    Array.from({ length: THREADS }, (_, i) =>
      transport.feedMessage({
        channel: `D0LOAD${i}`,
        user: "U0MGR",
        text: `load turn ${round}`,
        channel_type: "im",
        team: "T_SIM",
        ts: `7${String(i).padStart(4, "0")}.${round}`,
        thread_ts: `7${String(i).padStart(4, "0")}.0`,
      }),
    ),
  );
}
const enqueuedInMs = Date.now() - t0;

// Wait for every turn to complete.
const deadline = Date.now() + DEADLINE_MS;
while (replies() < expectReplies) {
  if (Date.now() > deadline) {
    console.error(`[load] FAIL: only ${replies()}/${expectReplies} turns completed within ${DEADLINE_MS}ms`);
    await cluster.stop();
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 100));
}
const wallMs = Date.now() - t0;
await cluster.stop();
await cluster.handle.stop().catch(() => {});

const ms = samplesSec.map((s) => s * 1000).sort((a, b) => a - b);
const pct = (p: number) => ms[Math.min(ms.length - 1, Math.max(0, Math.ceil((p / 100) * ms.length) - 1))]!;
console.log(`[load] ${expectReplies} turns done in ${wallMs}ms (enqueue fan-out ${enqueuedInMs}ms)`);
console.log(
  `[load] claim latency over ${ms.length} claims: p50=${pct(50).toFixed(1)}ms p95=${pct(95).toFixed(1)}ms p99=${pct(99).toFixed(1)}ms max=${ms.at(-1)!.toFixed(1)}ms`,
);
if (pct(95) > P95_MS) {
  console.error(`[load] FAIL: claim p95 ${pct(95).toFixed(1)}ms > budget ${P95_MS}ms`);
  process.exit(1);
}
console.log(`[load] PASS: claim p95 within the ${P95_MS}ms budget`);
process.exit(0);
