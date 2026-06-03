// Sim entrypoint. Three shapes:
//   bun run sim              → SHARED: boot like `bun run start` (real $SLAUDE_HOME config,
//                              real SOUL.md + gates, real agent) but bind an in-memory
//                              transport. State (db + workspaces) is redirected under
//                              $SLAUDE_HOME/sim/ so prod is never mutated. --stub for offline.
//   bun run sim --fixture    → legacy isolated preset REPL (temp $SLAUDE_HOME, /scenario).
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
  const { loadDotenv } = await import("../../config/env");
  loadDotenv(join(process.cwd(), ".env"));
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
  const { LiveTerminal } = await import("./term");
  const r = new ReplController(agentMode, soulMd, shared);

  // The live terminal owns a bottom-pinned status line (spinner + activity) and lets
  // committed lines scroll above it — the claude-code feel. A ~120ms interval advances the
  // spinner; tick() is a no-op whenever no status is active (e.g. while awaiting input), so
  // it never clobbers what the user is typing.
  const term = new LiveTerminal((s) => process.stdout.write(s));
  r.onOutput((l) => term.print(l));
  r.onStatus((l) => term.status(l));
  const spin = setInterval(() => term.tick(), 120);

  const mode = agentMode === "real" ? "live agent" : "stub";
  const tail = `a/d/A (or 1/2/3) answers gates · /help · Ctrl-D quits.${verbose ? "" : "  (--verbose for infra logs)"}`;
  term.print(`\x1b[1m✻ slaude sim\x1b[0m  \x1b[2m${mode}\x1b[0m`);
  if (shared) {
    await r.startShared();
    term.print(`\x1b[2mshared config (real ~/.slaude, state under sim/) — ${tail}\x1b[0m`);
  } else {
    await r.handle("/scenarios");
    term.print(`\x1b[2m${soulPath ? `soul=${soulPath} · ` : ""}fixture — /scenario <n> to start, then chat. ${tail}\x1b[0m`);
  }

  // node:readline gives real line editing — arrow keys move the cursor, ↑/↓ recall history,
  // Home/End/Ctrl-A/E, backspace — which the bare `for await (console)` line reader lacks.
  // Turn-based flow keeps it simple: we pause readline while a turn runs so its input echo
  // never fights the live spinner, then re-prompt. Type-ahead is buffered by the TTY.
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true, prompt: "\x1b[2m›\x1b[0m " });
  const showPrompt = () => { process.stdout.write("\n"); rl.prompt(); };

  let chain: Promise<void> = Promise.resolve();
  rl.on("line", (line) => {
    chain = chain.then(async () => {
      rl.pause();
      if (line.trim()) {
        try { await r.handle(line); } catch (e) { term.print(`! ${(e as Error).message}`); }
      }
      rl.resume();
      showPrompt();
    });
  });
  rl.on("SIGINT", () => rl.close());          // Ctrl-C
  rl.on("close", async () => {                // Ctrl-D / EOF
    clearInterval(spin);
    await r.dispose();
    process.exit(0);
  });
  showPrompt();
}
