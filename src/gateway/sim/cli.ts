// Force an isolated $SLAUDE_HOME BEFORE importing anything that reads config/home,
// so the sim never touches the operator's real ~/.slaude.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.SLAUDE_HOME = mkdtempSync(join(tmpdir(), "slaude-sim-"));
process.env.SLAUDE_HEALTH_PORT = "0";

const { ensureHome } = await import("../../config/home");
ensureHome();

const rawArgs = process.argv.slice(2);
// --real: drive turns with the live AgentManager (real LLM) instead of StubAgent.
const agentMode: "stub" | "real" = rawArgs.includes("--real") ? "real" : "stub";
// --verbose: keep the raw infra logs ([mgr]/[agent-evt]/[slack-rx]…). Default hides
// them so the REPL reads like a clean claude-code chat.
const verbose = rawArgs.includes("--verbose") || rawArgs.includes("-v");
const positional = rawArgs.filter((a) => !a.startsWith("--") && a !== "-v");
const mode = positional[0];
const args = positional.slice(1);

// Real agent needs creds. The isolated temp $SLAUDE_HOME has no .env, so pull
// ANTHROPIC_*/SLAUDE_MODEL from the project-cwd .env if present (no override).
if (agentMode === "real") {
  const { loadDotenv } = await import("../../config/env");
  loadDotenv(join(process.cwd(), ".env"));
}

// Capture the real console.log BEFORE muting, so REPL output always prints.
const realLog = console.log.bind(console);
if (!verbose && mode !== "run") {
  // Infra chatter is tagged like "[mgr] …", "[agent-evt] …". Drop those lines;
  // let everything else (the REPL feed) through.
  const NOISE = /^\[(mgr|agent-evt|slack-rx|slaude|slack-auth|presence|stop-guard|reactions|cron|permission-gate|metrics|ingest|skills|connect|broker)\]/;
  const mute = (orig: (...a: any[]) => void) => (...a: any[]) => { if (NOISE.test(String(a[0] ?? ""))) return; orig(...a); };
  console.log = mute(realLog);
  console.error = mute(console.error.bind(console));
  // Some infra (stop-guard) writes straight to stderr, bypassing console.
  const realErrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: any, ...rest: any[]) => NOISE.test(String(chunk)) ? true : realErrWrite(chunk, ...rest)) as typeof process.stderr.write;
}

if (mode === "run") {
  const { parseTranscript, runTranscript } = await import("./transcript");
  const { readFileSync } = await import("node:fs");
  const { Glob } = await import("bun");
  const patterns = args.length ? args : ["src/gateway/sim/scenarios/*.yaml"];
  let failures = 0;
  let ran = 0;
  for (const pat of patterns) {
    for await (const file of new Glob(pat).scan(".")) {
      ran++;
      try { await runTranscript(parseTranscript(readFileSync(file, "utf8")), agentMode); console.log(`✓ ${file}`); }
      catch (e) { failures++; console.error(`✗ ${file}\n  ${(e as Error).message}`); }
    }
  }
  console.log(`\n${ran - failures}/${ran} transcripts passed`);
  process.exit(failures ? 1 : 0);
} else {
  const { ReplController } = await import("./repl");
  const r = new ReplController(agentMode);
  r.onOutput((l) => realLog(l));   // REPL feed bypasses the noise filter
  await r.handle("/scenarios");
  realLog(
    `\n${agentMode === "real" ? "live agent" : "stub"} — /scenario <n> to start, then chat. ` +
    `a/d/A answers gates · /help · Ctrl-D quits.${verbose ? "" : "  (--verbose for infra logs)"}\n`,
  );
  for await (const line of (console as any)) {
    if (!line.trim()) continue;
    try { await r.handle(line); } catch (e) { realLog(`! ${(e as Error).message}`); }
  }
  await r.dispose();
  process.exit(0);
}
