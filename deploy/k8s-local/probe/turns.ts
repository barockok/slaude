#!/usr/bin/env bun
// Turn-delivery probe for verify-turns.sh. Runs INSIDE a gateway pod, so it uses
// the deployment's own Redis, Postgres and key prefix — nothing is stubbed.
//
//   enqueue <n> [--persona <name>] [--label <label>|live]
//                 create n sessions and enqueue one turn each (default persona
//                 unless --persona names another). `--label live` resolves the
//                 persona's CURRENT label the way dispatch does (runsOnFor on a
//                 freshly built persona registry). Prints the sessions and label.
//   again 1 [--persona <name>] [--label <label>]
//                 enqueue one more turn into the FIRST session the last
//                 `enqueue` created (same thread, same persona), and track only
//                 that turn — a second turn in a session a node holds warm
//   status        JSON: how many of those turns carry a completion marker, plus
//                 what the label's queue (`turns` for default; reported as
//                 `shared`) still holds
//   cron          insert one already-due cron job
//   cron-status   JSON: whether its schedule advanced, its result, and how many
//                 turn jobs exist for its synthetic session
//   cleanup       remove the rows and markers this probe created
//   token 1 [--persona <name>] [--label <label>|live]
//                 create one session and print ONLY a job token for it on
//                 stdout, for piping into the node probe (probe/node.ts). Never
//                 printed to a terminal by the verify scripts.
//   legacy-whoami JSON: { status, legacy } of GET /v1/node/whoami presented with
//                 this gateway's SLAUDE_NODE_LEGACY_TOKEN (401 when the legacy
//                 door is closed)
//   unserved <label>
//                 JSON: { value } of slaude_label_unserved{label} on THIS gateway
//                 replica's /metrics (only the reaper leader exports it; null
//                 when this replica has no such series)
//   box-check 1 --persona <name>
//                 JSON: { enabled, box, digest, tier } for the box the persona's
//                 next new session would be pinned to (nothing is pinned);
//                 `box` is null when the persona names none
//   box-turn <n> --persona <name> [--label <label>|live] --cmd <base64url> --id <word> [--again]
//                 n NEW sessions (or, with --again, one more turn in the first
//                 session of the last box-turn), each pinned to the persona's
//                 box the way dispatch pins it, each with ONE REAL turn: the
//                 mock model (`[[mock:multi-tool ...]]`) asks for one Bash call
//                 running the decoded command. NOT suppressed: the CLI runs, in
//                 a box when the session is pinned. Needs the mock model as
//                 the provider; against a real provider the tag is just text.
//                 Prints { enqueued, sessions, label, box, digest, workdirs }.
//                 WRITTEN, NOT RUN: no cluster has run a boxed turn.
//
// The probe's turns are SUPPRESSED (all but box-turn's): the node runs the full turn lifecycle and
// writes its completion marker, but the prompt hook stops the model, so the probe
// costs no provider tokens. What is under test is DELIVERY — every enqueued turn
// reaching a node exactly once, even when a node dies mid-flight.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getRedis } from "/app/src/queue/redis.ts";
import { labelTurnsQueue, LABEL_RE, makeKeys } from "/app/src/queue/keys.ts";
import { TurnQueues } from "/app/src/queue/turns.ts";
import { mintJobToken } from "/app/src/gateway/api/auth.ts";
import { db } from "/app/src/db/schema.ts";
import * as Sessions from "/app/src/db/sessions.ts";
import * as CronJobs from "/app/src/db/cron-jobs.ts";
import { env } from "/app/src/config/env.ts";
import { buildPersonaRegistry, runsOnFor } from "/app/src/persona/registry.ts";
// The box commands load what they need themselves (below), so that an image
// older than boxes still runs every other command of this probe.

const TEAM = "TVERIFY";
const CHANNEL = "CVERIFY";
const MARK = "verify-turns";
const CRON_MARK = "verify-cron";
const STATE = "/tmp/verify-turns-ids.json";
// The sessions the last `enqueue` created, for `again`.
const SESSIONS = "/tmp/verify-turns-sessions.json";

const [cmd, arg, ...rest] = process.argv.slice(2);
// `--persona <name>` after the count. Absent, the probe behaves exactly as it
// always did: every id below is "default".
const personaFlag = rest.indexOf("--persona");
const PERSONA = personaFlag >= 0 ? (rest[personaFlag + 1] ?? "") : "default";
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(PERSONA)) {
  console.error(`--persona needs a lowercase name (got '${PERSONA}')`);
  process.exit(2);
}
// `--label <label>`: the node label the turns run on (signed into the token,
// carried in the payload, and the queue they land on). Absent = `default`, the
// `turns` queue, exactly as before labels.
const labelFlag = rest.indexOf("--label");
const labelArg = labelFlag >= 0 ? (rest[labelFlag + 1] ?? "") : "default";
// `live`: the persona's label as dispatch would resolve it now.
const LABEL = labelArg === "live" ? runsOnFor(PERSONA, await buildPersonaRegistry("default")) : labelArg;
if (!LABEL_RE.test(LABEL)) {
  console.error(`--label needs a node label or 'live' (got '${labelArg}')`);
  process.exit(2);
}
const QUEUE = labelTurnsQueue(LABEL);
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

async function enqueueOne(session: { id: string }, thread: string, i: number): Promise<string> {
  const jobId = randomUUID();
  const jobToken = mintJobToken({
    label: LABEL, tenant: "default", persona: PERSONA, session: session.id,
    team: TEAM, channel: CHANNEL, thread, initiator: "UVERIFY",
    scope: "turn", runAs: "agent", job: jobId, lock: null,
  });
  const r = await turns.enqueueTurn(
    {
      sessionId: session.id,
      tenantId: "default",
      personaId: PERSONA,
      label: LABEL,
      // suppress: the node runs the whole turn lifecycle — claim, session
      // lock, completion marker, ack — but the prompt hook stops the model, so
      // the probe costs no tokens and still proves delivery.
      messages: [{ ts: `${Date.now()}.${i}`, user: "UVERIFY", text: `${MARK}: delivery probe`, suppress: true }],
      jobToken,
      enqueuedAt: Date.now(),
    },
    { label: LABEL },
    jobId,
  );
  return r.jobId;
}

async function enqueue(n: number) {
  const ids: string[] = [];
  const sessions: Array<{ id: string; thread: string }> = [];
  for (let i = 0; i < n; i++) {
    const thread = `${MARK}-${Date.now()}-${i}`;
    const session = await Sessions.createForThread({
      thread: { team_id: TEAM, channel_id: CHANNEL, thread_ts: thread, persona_id: PERSONA },
      // The deployment's own model: a bogus one makes the child fail to boot,
      // which looks like a delivery failure and is not one.
      model: env.model(),
      working_dir: "/tmp",
      title: MARK,
    });
    sessions.push({ id: session.id, thread });
    ids.push(await enqueueOne(session, thread, i));
  }
  writeFileSync(STATE, JSON.stringify(ids));
  writeFileSync(SESSIONS, JSON.stringify(sessions));
  console.log(
    JSON.stringify({ enqueued: ids.length, session: sessions[0]?.id ?? null, sessions: sessions.map((s) => s.id), label: LABEL }),
  );
}

// --- boxes ---------------------------------------------------------------------
const flag = (name: string): string | undefined => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};

/** The persona's box as dispatch reads it, with the persona registry this process built. */
async function boxModules() {
  const registry = await import("/app/src/persona/registry.ts");
  registry.setPersonaRegistry(await buildPersonaRegistry("default"));
  const pin = await import("/app/src/gateway/core/box-pin.ts");
  const boxes = await import("/app/src/gateway/core/box-registry.ts");
  return { registry, pin, boxes };
}

async function boxCheck() {
  const { registry, boxes } = await boxModules();
  const name = registry.managedPersonaDefinition(PERSONA === "default" ? undefined : PERSONA)?.box ?? env.box.defaultBox();
  const cur = name ? await boxes.currentBox("default", name) : null;
  console.log(JSON.stringify({ enabled: env.box.enabled(), box: name ?? null, digest: cur?.digest ?? null, tier: cur?.policy.tier ?? null }));
}

async function boxTurn(n: number) {
  const cmdB64 = flag("--cmd") ?? "";
  const id = flag("--id") ?? "";
  // The mock numbers its tool calls from 1 every turn, and the CLI drops a call
  // whose id an earlier turn of a resumed transcript used: every turn of a
  // thread needs its own id word (the 2026-11-25 box smoke note, item 12).
  if (!/^[A-Za-z0-9_-]+$/.test(cmdB64) || !/^[a-z0-9]{1,16}$/.test(id)) {
    console.error("box-turn needs --cmd <base64url of a shell command> and --id <word>");
    process.exit(2);
  }
  const command = Buffer.from(cmdB64, "base64url").toString("utf8");
  const args = Buffer.from(JSON.stringify({ command, description: "verify-turns box probe" })).toString("base64url");
  const { pin } = await boxModules();
  let sessions: Array<{ id: string; thread: string; workdir: string }> = [];
  if (rest.includes("--again")) {
    try {
      sessions = (JSON.parse(readFileSync(SESSIONS, "utf8")) as typeof sessions).slice(0, 1);
    } catch {
      /* no earlier box-turn */
    }
    if (!sessions.length || !sessions[0]!.workdir) {
      console.error("box-turn --again: no session from an earlier box-turn");
      process.exit(2);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const thread = `${MARK}-box-${Date.now()}-${i}`;
      // Under the slaude home: a box is only ever given directories under the
      // supervisor's mount roots, and /tmp is not one.
      const workdir = join(process.env.SLAUDE_HOME ?? "/data", "workspaces", thread);
      mkdirSync(workdir, { recursive: true });
      const session = await Sessions.createForThread({
        thread: { team_id: TEAM, channel_id: CHANNEL, thread_ts: thread, persona_id: PERSONA },
        model: env.model(),
        working_dir: workdir,
        title: MARK,
      });
      sessions.push({ id: session.id, thread, workdir });
    }
  }
  const ids: string[] = [];
  let box: { name: string; digest: string } | null = null;
  for (const [i, s] of sessions.entries()) {
    // The pin dispatch would have made. It throws when the box cannot be served; a turn is never sent unboxed instead.
    const pinned = await pin.sessionBoxPin({ tenant: "default", persona: PERSONA, sessionId: s.id });
    if (!pinned) {
      console.error(`box-turn: persona '${PERSONA}' is not boxed here (SLAUDE_BOX off, or it names no box)`);
      process.exit(3);
    }
    box = { name: pinned.name, digest: pinned.digest };
    const jobId = randomUUID();
    const jobToken = mintJobToken({
      label: LABEL, tenant: "default", persona: PERSONA, session: s.id,
      team: TEAM, channel: CHANNEL, thread: s.thread, initiator: "UVERIFY",
      scope: "turn", runAs: "agent", job: jobId, lock: null,
    });
    const r = await turns.enqueueTurn(
      {
        sessionId: s.id,
        tenantId: "default",
        personaId: PERSONA,
        label: LABEL,
        messages: [{ ts: `${Date.now()}.${i}`, user: "UVERIFY", text: `${MARK}: [[mock:multi-tool n=1 id=${id}${i} args=${args}]] run it` }],
        jobToken,
        enqueuedAt: Date.now(),
      },
      { label: LABEL },
      jobId,
    );
    ids.push(r.jobId);
  }
  writeFileSync(STATE, JSON.stringify(ids));
  if (!rest.includes("--again")) writeFileSync(SESSIONS, JSON.stringify(sessions));
  console.log(
    JSON.stringify({ enqueued: ids.length, sessions: sessions.map((x) => x.id), workdirs: sessions.map((x) => x.workdir), label: LABEL, box: box?.name ?? null, digest: box?.digest ?? null }),
  );
}

async function token() {
  const thread = `${MARK}-token-${Date.now()}`;
  const session = await Sessions.createForThread({
    thread: { team_id: TEAM, channel_id: CHANNEL, thread_ts: thread, persona_id: PERSONA },
    model: env.model(),
    working_dir: "/tmp",
    title: MARK,
  });
  process.stdout.write(
    mintJobToken({
      label: LABEL, tenant: "default", persona: PERSONA, session: session.id,
      team: TEAM, channel: CHANNEL, thread, initiator: "UVERIFY",
      scope: "turn", runAs: "agent", job: randomUUID(), lock: null,
    }),
  );
}

async function legacyWhoami() {
  const tok = process.env.SLAUDE_NODE_LEGACY_TOKEN;
  if (!tok) {
    console.log(JSON.stringify({ status: "unset" }));
    return;
  }
  const r = await fetch("http://localhost:8080/v1/node/whoami", { headers: { authorization: `Bearer ${tok}` } });
  let legacy: unknown = null;
  try {
    legacy = ((await r.json()) as { legacy?: unknown }).legacy ?? null;
  } catch {
    /* not JSON */
  }
  console.log(JSON.stringify({ status: r.status, legacy }));
}

async function unserved() {
  if (!arg || !LABEL_RE.test(arg)) {
    console.error("unserved needs a node label");
    process.exit(2);
  }
  const text = await (await fetch("http://localhost:8080/metrics")).text();
  const line = text.split("\n").find((l) => l.startsWith("slaude_label_unserved{") && l.includes(`label="${arg}"`));
  console.log(JSON.stringify({ value: line ? Number(line.trim().split(/\s+/).pop()) : null }));
}

async function again() {
  let first: { id: string; thread: string } | undefined;
  try {
    first = (JSON.parse(readFileSync(SESSIONS, "utf8")) as Array<{ id: string; thread: string }>)[0];
  } catch {
    /* no earlier enqueue */
  }
  if (!first) {
    console.error("again: no session from an earlier enqueue");
    process.exit(2);
  }
  const id = await enqueueOne(first, first.thread, 0);
  writeFileSync(STATE, JSON.stringify([id]));
  console.log(JSON.stringify({ enqueued: 1, session: first.id }));
}

async function status() {
  const ids = readIds();
  let done = 0;
  for (const id of ids) if (await redis.exists(keys.turnDone(id))) done++;
  const counts = await turns
    .queue(QUEUE)
    .getJobCounts("waiting", "active", "delayed", "completed", "failed");
  console.log(JSON.stringify({ tracked: ids.length, withCompletionMarker: done, shared: counts }));
}

async function cron() {
  const job = await CronJobs.create({
    slackTeamId: TEAM,
    slackChannelId: CHANNEL,
    channelId: CHANNEL,
    createdBy: "UVERIFY",
    // Hourly, not every minute: the scheduler ticks every 60s, so a claim on a
    // per-minute job moves the row only a fraction of a second ahead of now and
    // "scheduleAdvanced" would hold for that sliver of each minute.
    cronExpr: "0 * * * *",
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
      .queue(QUEUE)
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
  const q = turns.queue(QUEUE);
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
  again,
  status,
  cron,
  "cron-status": cronStatus,
  cleanup,
  token,
  "legacy-whoami": legacyWhoami,
  unserved,
  "box-check": boxCheck,
  "box-turn": () => boxTurn(Math.max(1, Number(arg ?? 1))),
};
const run = commands[cmd ?? ""];
if (!run) {
  console.error(
    "usage: turns.ts enqueue <n> [--persona <name>] [--label <label>|live] | again 1 --persona <name> | status | cron | " +
      "cron-status | cleanup | token 1 [--persona <name>] [--label <label>|live] | legacy-whoami | unserved <label> | " +
      "box-check 1 --persona <name> | box-turn <n> --persona <name> --cmd <base64url> --id <word> [--again]",
  );
  process.exit(2);
}
await run();
process.exit(0);
