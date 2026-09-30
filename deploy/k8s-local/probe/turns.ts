#!/usr/bin/env bun
// Turn-delivery probe for verify-turns.sh. Runs INSIDE a gateway pod, so it uses
// the deployment's own Redis, Postgres and key prefix — nothing is stubbed.
//
//   enqueue <n>   create n sessions and enqueue one turn each
//   status        JSON: how many of those turns carry a completion marker, plus
//                 what the shared queue still holds
//   cron          insert one already-due cron job
//   cron-status   JSON: whether its schedule advanced, its result, and how many
//                 turn jobs exist for its synthetic session
//   cleanup       remove the rows and markers this probe created
//
// The probe's turns are SUPPRESSED: the node runs the full turn lifecycle and
// writes its completion marker, but the prompt hook stops the model, so the probe
// costs no provider tokens. What is under test is DELIVERY — every enqueued turn
// reaching a node exactly once, even when a node dies mid-flight.
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { getRedis } from "/app/src/queue/redis.ts";
import { makeKeys, TURNS_QUEUE } from "/app/src/queue/keys.ts";
import { TurnQueues } from "/app/src/queue/turns.ts";
import { mintJobToken } from "/app/src/gateway/api/auth.ts";
import { db } from "/app/src/db/schema.ts";
import * as Sessions from "/app/src/db/sessions.ts";
import * as CronJobs from "/app/src/db/cron-jobs.ts";
import { env } from "/app/src/config/env.ts";

const TEAM = "TVERIFY";
const CHANNEL = "CVERIFY";
const MARK = "verify-turns";
const CRON_MARK = "verify-cron";
const STATE = "/tmp/verify-turns-ids.json";

const [cmd, arg] = process.argv.slice(2);
const redis = getRedis();
const keys = makeKeys();
const turns = new TurnQueues({ connection: redis, keys });

const readIds = (): string[] => {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return [];
  }
};

async function enqueue(n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const thread = `${MARK}-${Date.now()}-${i}`;
    const session = await Sessions.createForThread({
      thread: { team_id: TEAM, channel_id: CHANNEL, thread_ts: thread },
      // The deployment's own model: a bogus one makes the child fail to boot,
      // which looks like a delivery failure and is not one.
      model: env.model(),
      working_dir: "/tmp",
      title: MARK,
    });
    const jobId = randomUUID();
    const jobToken = mintJobToken({
      tenant: "default", persona: "default", session: session.id,
      team: TEAM, channel: CHANNEL, thread, initiator: "UVERIFY",
      scope: "turn", runAs: "agent", job: jobId,
    });
    const r = await turns.enqueueTurn(
      {
        sessionId: session.id,
        tenantId: "default",
        personaId: "default",
        // suppress: the node runs the whole turn lifecycle — claim, session
        // lock, completion marker, ack — but the prompt hook stops the model, so
        // the probe costs no tokens and still proves delivery.
        messages: [{ ts: `${Date.now()}.${i}`, user: "UVERIFY", text: `${MARK}: delivery probe`, suppress: true }],
        jobToken,
        enqueuedAt: Date.now(),
      },
      "shared",
      jobId,
    );
    ids.push(r.jobId);
  }
  writeFileSync(STATE, JSON.stringify(ids));
  console.log(JSON.stringify({ enqueued: ids.length }));
}

async function status() {
  const ids = readIds();
  let done = 0;
  for (const id of ids) if (await redis.exists(keys.turnDone(id))) done++;
  const counts = await turns
    .queue(TURNS_QUEUE)
    .getJobCounts("waiting", "active", "delayed", "completed", "failed");
  console.log(JSON.stringify({ tracked: ids.length, withCompletionMarker: done, shared: counts }));
}

async function cron() {
  const job = await CronJobs.create({
    slackTeamId: TEAM,
    slackChannelId: CHANNEL,
    channelId: CHANNEL,
    createdBy: "UVERIFY",
    cronExpr: "* * * * *",
    prompt: `${CRON_MARK}: fire once`,
    nextRunAt: Date.now() - 1000,
    target: "channel",
  });
  console.log(JSON.stringify({ cronJobId: job.id, wasDueAt: job.nextRunAt }));
}

async function cronStatus() {
  const job = (await CronJobs.listActive()).find((j) => j.prompt.startsWith(CRON_MARK));
  if (!job) {
    console.log(JSON.stringify({ found: false }));
    return;
  }
  const session = await Sessions.findAnyByThread({
    team_id: TEAM,
    channel_id: CHANNEL,
    thread_ts: `cron:${job.id}`,
  });
  // One dispatch per occurrence: count every turn job that exists for the cron
  // session, in any state.
  let jobsForSession = 0;
  if (session) {
    const all = await turns
      .queue(TURNS_QUEUE)
      .getJobs(["waiting", "active", "completed", "failed", "delayed"], 0, 500);
    jobsForSession = all.filter((j) => j?.data?.sessionId === session.id).length;
  }
  console.log(
    JSON.stringify({
      found: true,
      // Claimed at dispatch: the row must already point at a future slot.
      scheduleAdvanced: Number(job.nextRunAt) > Date.now(),
      lastResult: job.lastResult,
      sessionExists: !!session,
      jobsForSession,
    }),
  );
}

async function cleanup() {
  // Drain first: deleting a session row out from under a turn that is still
  // retrying turns a slow turn into "session not found", which reads as a
  // delivery failure and is not one.
  const q = turns.queue(TURNS_QUEUE);
  const mine = (j: { data?: { messages?: Array<{ text?: string }> } } | undefined) =>
    (j?.data?.messages ?? []).some((m) => String(m?.text ?? "").startsWith(MARK));
  for (const j of await q.getJobs(["waiting", "active", "delayed", "failed"], 0, 500)) {
    if (mine(j)) await j.remove().catch(() => {});
  }
  for (const id of readIds()) await redis.del(keys.turnDone(id));
  await db.run("DELETE FROM cron_jobs WHERE prompt LIKE ?", [`${CRON_MARK}%`]);
  await db.run("DELETE FROM sessions WHERE slack_team_id = ?", [TEAM]);
  console.log(JSON.stringify({ cleaned: true }));
}

const commands: Record<string, () => Promise<void>> = {
  enqueue: () => enqueue(Math.max(1, Number(arg ?? 4))),
  status,
  cron,
  "cron-status": cronStatus,
  cleanup,
};
const run = commands[cmd ?? ""];
if (!run) {
  console.error("usage: turns.ts enqueue <n> | status | cron | cron-status | cleanup");
  process.exit(2);
}
await run();
process.exit(0);
