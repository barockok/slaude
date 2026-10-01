#!/usr/bin/env bun
// Persona seeding for the e2e cluster. Runs INSIDE a gateway pod (copied to /tmp and run with
// bun) and imports the image's own /app/src paths, which do not resolve on a developer machine,
// so it is excluded from tsconfig and verified by running it.
//
//   bun /tmp/seed-persona.ts --persona-id alpha --api-app-id A0X --team-id T0X \
//     --bot-token <t> --signing-secret <s> --bot-user-id U0X
//
// 1. SOUL.md = the sim WORLD fixture + a `Persona-ID: <id>` line (the mock LLM reads it).
// 2. The structured soul cache file. The gateway normally builds it with an LLM call; the mock
//    LLM would answer with garbage and the regex fallback never fills the manager, so a DM from
//    the manager would be ignored. Seeding the cache sidesteps that.
// 3. slack-app add (the same logic as `bun run slack-app add`).
// 4. Self-verify with the LLM endpoint unreachable: a cache hit must yield manager U0MGR.
//
// SAFETY: this overwrites $SLAUDE_HOME/SOUL.md, so it refuses to run unless SLAUDE_E2E_SEED=1 is
// set (callers pass it through execIn, e.g. execIn(pod, "gateway", ["env", "SLAUDE_E2E_SEED=1",
// "bun", "/tmp/seed-persona.ts", ...])). It also refuses to replace a SOUL.md that has no
// `Persona-ID:` line (not written by this script) unless it is the gateway's untouched starter
// persona or SLAUDE_E2E_SEED_FORCE=1 is also set. On a fresh cluster the gateway writes that
// starter at boot, so it must stay replaceable. The decision lives in ./soul-guard.ts (pure, unit
// tested); the driver copies it into the pod next to this file.
// Re-running is idempotent: SOUL.md is rewritten whole and the registry row is an upsert.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "/app/src/config/home.ts";
import { main as slackApp } from "/app/src/cli/slack-app.ts";
import { WORLD, writeSoulFixture } from "/app/src/gateway/sim/soul-fixture.ts";
import { __resetSoulDataMemo, loadSoulData, soulData } from "/app/src/soul/extract.ts";
import { loadSoul } from "/app/src/soul/loader.ts";
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

// Guard: nothing is written before these pass.
const soulKind = classifySoul(existsSync(paths.soul) ? readFileSync(paths.soul, "utf8") : null);
const refusal = seedRefusal(soulKind, process.env, paths.soul);
if (refusal) fail(refusal);
console.log(`[seed-persona] replacing a SOUL.md of kind '${soulKind}'`);

// 1. SOUL.md
writeSoulFixture(WORLD);
appendFileSync(paths.soul, `\nPersona-ID: ${f["persona-id"]}\n`, "utf8");

// 2. Soul cache. Mirrors sha256()/cachePath() in /app/src/soul/extract.ts, which are private:
//    if that file changes its key or location, the self-check below fails.
const sha = createHash("sha256").update(loadSoul()).digest("hex").slice(0, 16);
const cacheDir = join(paths.home, "cache");
mkdirSync(cacheDir, { recursive: true });
writeFileSync(join(cacheDir, `soul.${sha}.json`), JSON.stringify(soulData(), null, 2), "utf8");

// 3. Registry row
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

// 4. Self-verify: any extraction attempt hits a closed port, so only a cache hit can succeed.
__resetSoulDataMemo();
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";
const data = await loadSoulData();
if (data.manager?.userId !== WORLD.manager) {
  fail(`soul cache was not hit (manager=${data.manager?.userId ?? "none"}, expected ${WORLD.manager})`);
}
console.log(`[seed-persona] soul cache hit for ${sha}, manager ${data.manager.userId}`);
