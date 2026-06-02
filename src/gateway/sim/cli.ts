// Force an isolated $SLAUDE_HOME BEFORE importing anything that reads config/home,
// so the sim never touches the operator's real ~/.slaude.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.SLAUDE_HOME = mkdtempSync(join(tmpdir(), "slaude-sim-"));
process.env.SLAUDE_HEALTH_PORT = "0";

const { ensureHome } = await import("../../config/home");
ensureHome();

const [, , mode, ...args] = process.argv;

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
      try { await runTranscript(parseTranscript(readFileSync(file, "utf8"))); console.log(`✓ ${file}`); }
      catch (e) { failures++; console.error(`✗ ${file}\n  ${(e as Error).message}`); }
    }
  }
  console.log(`\n${ran - failures}/${ran} transcripts passed`);
  process.exit(failures ? 1 : 0);
} else {
  const { ReplController } = await import("./repl");
  const r = new ReplController();
  r.onOutput((l) => console.log(l));
  await r.handle("/scenarios");
  console.log("\nPick a scenario: /scenario <n>. Then type a message. /cards, /click <n> <verb>, /state, Ctrl-D to quit.\n");
  for await (const line of (console as any)) {
    if (!line.trim()) continue;
    try { await r.handle(line); } catch (e) { console.error((e as Error).message); }
  }
  await r.dispose();
}
