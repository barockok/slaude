// Sim entrypoint. Three shapes:
//   bun run sim              → SHARED: boot like `bun run start` (real $SLAUDE_HOME config,
//                              real SOUL.md + gates, real agent) but bind an in-memory
//                              transport. State (db + workspaces) is redirected under
//                              $SLAUDE_HOME/sim/ so prod is never mutated. --stub for offline.
//   bun run sim --fixture    → isolated WORLD-soul REPL (temp $SLAUDE_HOME); compose with
//                              /layer · /as · /behavior.
//   bun run sim run [glob]   → transcripts/CI: isolated temp home + fixtures + stub.
import { mkdtempSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const rawArgs = process.argv.slice(2);
const verbose = rawArgs.includes("--verbose") || rawArgs.includes("-v");
const wantStub = rawArgs.includes("--stub");
const wantReal = rawArgs.includes("--real");
const fixtureRepl = rawArgs.includes("--fixture");

// --soul <path>: in fixture/run, drive the agent persona from a real SOUL.md. Ignored in
// shared mode (which uses the operator's real SOUL.md and must never overwrite it).
let soulPath: string | undefined;
const soulIdx = rawArgs.indexOf("--soul");
if (soulIdx !== -1) soulPath = rawArgs[soulIdx + 1];
const consumed = new Set(soulPath ? ["--soul", soulPath] : []);
const positional = rawArgs.filter((a) => !a.startsWith("--") && a !== "-v" && !consumed.has(a));
const mode = positional[0];
const args = positional.slice(1);

const isRun = mode === "run";
const isolated = isRun || fixtureRepl;   // isolated temp home + fixtures
const shared = !isolated;

// Agent default: isolated paths stay deterministic (stub unless --real); shared mode mirrors
// `start` with the real agent (unless --stub).
const agentMode: "stub" | "real" = isolated ? (wantReal ? "real" : "stub") : (wantStub ? "stub" : "real");

// Home + state strategy — MUST run before importing config/home (it reads these at load).
if (isolated) {
  process.env.SLAUDE_HOME = mkdtempSync(join(tmpdir(), "slaude-sim-"));
  process.env.SLAUDE_HEALTH_PORT = "0";
} else {
  // Share the real $SLAUDE_HOME config; redirect mutable state under $SLAUDE_HOME/sim/.
  const home = process.env.SLAUDE_HOME || join(homedir(), ".slaude");
  process.env.SLAUDE_DB_PATH ??= join(home, "sim", "db.sqlite");
  process.env.SLAUDE_WORKSPACES ??= join(home, "sim", "workspaces");
  process.env.SLAUDE_HEALTH_PORT ??= "0";
}

const { ensureHome } = await import("../../config/home");
ensureHome();

// config/env auto-loads $SLAUDE_HOME/.env at import. For a real agent also pull the project
// ./.env as a dev fallback (no override of already-set vars).
if (agentMode === "real") {
  const { loadDotenv, env } = await import("../../config/env");
  loadDotenv(join(process.cwd(), ".env"));
  // Preflight: a real turn needs a provider credential. Warn early + actionably (the SDK
  // would otherwise just 401 mid-turn). The classifier import is cheap and side-effect-free.
  const { missingCredsWarning } = await import("./preflight");
  const warn = missingCredsWarning({
    apiKey: env.provider.apiKey(),
    authToken: env.provider.authToken(),
    oauthToken: env.provider.oauthToken(),
  });
  if (warn) console.error(warn);
}

// Custom persona file — only meaningful for isolated (fixture/run) modes.
let soulMd: string | undefined;
if (soulPath && isolated) {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  soulMd = readFileSync(resolve(process.cwd(), soulPath), "utf8");
}

// Capture the real console.log BEFORE muting, so REPL output always prints.
const realLog = console.log.bind(console);
if (!verbose && !isRun) {
  const NOISE = /^\[(mgr|agent-evt|slack-rx|slaude|slack-auth|presence|stop-guard|reactions|cron|permission-gate|metrics|ingest|skills|connect|broker)\]/;
  const mute = (orig: (...a: any[]) => void) => (...a: any[]) => { if (NOISE.test(String(a[0] ?? ""))) return; orig(...a); };
  console.log = mute(realLog);
  console.error = mute(console.error.bind(console));
  const realErrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: any, ...rest: any[]) => NOISE.test(String(chunk)) ? true : realErrWrite(chunk, ...rest)) as typeof process.stderr.write;
}

if (isRun) {
  const { parseTranscript, runTranscript } = await import("./transcript");
  const { readFileSync } = await import("node:fs");
  const { Glob } = await import("bun");
  const patterns = args.length ? args : ["src/gateway/sim/scenarios/*.yaml"];
  let failures = 0;
  let ran = 0;
  for (const pat of patterns) {
    for await (const file of new Glob(pat).scan(".")) {
      ran++;
      try { await runTranscript(parseTranscript(readFileSync(file, "utf8")), agentMode, soulMd); console.log(`✓ ${file}`); }
      catch (e) { failures++; console.error(`✗ ${file}\n  ${(e as Error).message}`); }
    }
  }
  console.log(`\n${ran - failures}/${ran} transcripts passed`);
  process.exit(failures ? 1 : 0);
} else {
  const { ReplController } = await import("./repl");
  const { mountTui } = await import("./tui/mount");
  const r = new ReplController(agentMode, soulMd);

  const modeLabel = agentMode === "real" ? "live agent" : "stub";
  const tail = `${modeLabel} · a/d/A (or pick) answers gates · /help · Ctrl-D quits.${verbose ? "" : "  (--verbose for infra logs)"}`;

  // startShared/startDefault run before the app subscribes (onOutput is registered in a mount
  // effect). ReplController buffers output until then, so the intro line + any "no manager"
  // warning replay into the scrollbox once useRepl attaches its sink.
  if (shared) await r.startShared();
  else await r.startDefault();

  // mountTui owns the screen until the user exits (Ctrl-C/Ctrl-D); it disposes the controller.
  await mountTui(r, { hint: tail, helpLines: r.helpLines() });
  process.exit(0);
}
