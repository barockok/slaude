#!/usr/bin/env bun
// Persona seeding for the e2e cluster. Runs INSIDE a gateway pod (copied to /tmp and run with
// bun) and imports the image's own /app/src paths, which do not resolve on a developer machine,
// so it is excluded from tsconfig and verified by running it.
//
//   bun /tmp/seed-persona.ts --persona-id alpha --api-app-id A0X --team-id T0X \
//     --bot-token <t> --signing-secret <s> --bot-user-id U0X
//
// 1. $SLAUDE_HOME/agent.yaml = the sim WORLD fixture (manager, backup, approver, channels) as an
//    agent.yaml, with a `Persona-ID: <id>` line in its soul prose (the mock LLM reads it). Any
//    SOUL.md is removed: the gateway refuses a home that has both.
// 2. slack-app add (the same logic as `bun run slack-app add`).
// 3. Self-verify: the file compiles and yields manager U0MGR, with no model involved.
//
// SAFETY: this overwrites $SLAUDE_HOME/agent.yaml, so it refuses to run unless SLAUDE_E2E_SEED=1 is
// set (callers pass it through execIn, e.g. execIn(pod, "gateway", ["env", "SLAUDE_E2E_SEED=1",
// "bun", "/tmp/seed-persona.ts", ...])). It also refuses to replace an agent.yaml that has no
// `Persona-ID:` line (not written by this script) unless it is the gateway's untouched starter
// or SLAUDE_E2E_SEED_FORCE=1 is also set. On a fresh cluster the gateway writes that starter at
// boot, so it must stay replaceable. The decision lives in ./soul-guard.ts (pure, unit tested);
// the driver copies it into the pod next to this file. It refuses, too, when the tenant is managed
// by personas as code: the gateway then takes its personas from the database.
// Re-running is idempotent: agent.yaml is rewritten whole and the registry row is an upsert.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { paths } from "/app/src/config/home.ts";
import { main as slackApp } from "/app/src/cli/slack-app.ts";
import { dbDialect } from "/app/src/db/client.ts";
import { isManaged } from "/app/src/db/personas.ts";
import { WORLD } from "/app/src/gateway/sim/soul-fixture.ts";
import { readFileAgent } from "/app/src/persona/file-agent.ts";
import { classifySoul, seedRefusal } from "./soul-guard.ts";

function flagsOf(argv: string[]): Record<string, string> {
  const f: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]!;
    const v = argv[i + 1];
    if (!k.startsWith("--") || v === undefined) throw new Error(`bad argument near '${k}'`);
    f[k.slice(2)] = v;
  }
  return f;
}

const fail = (msg: string): never => {
  console.error(`[seed-persona] ${msg}`);
  process.exit(1);
};

const f = flagsOf(process.argv.slice(2));
for (const k of ["persona-id", "api-app-id", "team-id", "bot-token", "signing-secret", "bot-user-id"]) {
  if (!f[k]) fail(`missing --${k}`);
}

const agentFile = join(paths.home, "agent.yaml");
const soulFile = join(paths.home, "SOUL.md");

// Guard: nothing is written before these pass.
const soulKind = classifySoul(existsSync(agentFile) ? readFileSync(agentFile, "utf8") : null);
const refusal = seedRefusal(soulKind, process.env, agentFile);
if (refusal) fail(refusal);
// A tenant synced as personas as code reads its personas from the database, never from
// agent.yaml, so seeding it would succeed and change nothing the gateway uses.
// deploy/k8s-local/verify-ha.sh syncs one (with a default persona that names no manager).
if (dbDialect() === "pg" && (await isManaged("default"))) {
  fail(
    "refusing to seed: tenant 'default' is managed by personas as code (a /deploy sync ran on this cluster, " +
      "for example deploy/k8s-local/verify-ha.sh), so the gateway ignores agent.yaml. " +
      "This suite needs a never-synced tenant: a fresh cluster (deploy/k8s-local/down.sh, then e2e/up.sh).",
  );
}
console.log(`[seed-persona] replacing an agent.yaml of kind '${soulKind}'`);

// 1. agent.yaml, and no SOUL.md beside it.
const doc = {
  name: "default",
  soul: `# SOUL\n\nSim agent.\n\nPersona-ID: ${f["persona-id"]}\n`,
  access: {
    manager: `slack:user:${WORLD.manager}`,
    ...(WORLD.backup ? { backupManager: `slack:user:${WORLD.backup}` } : {}),
    approvers: WORLD.approvers.map((user) => ({ user: `slack:user:${user}`, scope: "anything" })),
    channels: {
      public: WORLD.allowed.map((c) => `slack:channel:${c}`),
      trusted: WORLD.trusted.map((c) => `slack:channel:${c}`),
    },
  },
};
writeFileSync(agentFile, yamlStringify(doc, { lineWidth: 0 }), "utf8");
rmSync(soulFile, { force: true });

// 2. Registry row
const code = await slackApp(
  [
    "add",
    "--api-app-id", f["api-app-id"]!,
    "--team-id", f["team-id"]!,
    "--bot-token", f["bot-token"]!,
    "--signing-secret", f["signing-secret"]!,
    "--bot-user-id", f["bot-user-id"]!,
    "--persona", f["persona-id"]!,
  ],
  {},
);
if (code !== 0) fail(`slack-app add exited ${code}`);

// 3. Self-verify: the file the gateway will read compiles and names the manager.
const agent = readFileAgent(paths.home, "default");
if (agent?.soulJson.manager.userId !== WORLD.manager) {
  fail(`agent.yaml did not compile to manager ${WORLD.manager} (got ${agent?.soulJson.manager.userId ?? "none"})`);
}
console.log(`[seed-persona] agent.yaml written at ${agentFile}, manager ${agent.soulJson.manager.userId}`);
// Exit explicitly: an open database handle must not keep a finished seed alive (observed with
// PGLite reopening a persisted data directory, which the host test of this script uses).
process.exit(0);
