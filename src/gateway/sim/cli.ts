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
  const { ReplController, replCommandNames } = await import("./repl");
  const { LiveTerminal } = await import("./term");
  const { completeLine } = await import("./complete");
  const { sigintAction } = await import("./interrupt");
  const r = new ReplController(agentMode, soulMd);

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
    await r.startDefault();
    term.print(`\x1b[2m${soulPath ? `soul=${soulPath} · ` : ""}fixture — compose with /layer · /as · /behavior, then chat. ${tail}\x1b[0m`);
  }

  // node:readline gives real line editing — arrow keys move the cursor, ↑/↓ recall history,
  // Home/End/Ctrl-A/E, backspace — which the bare `for await (console)` line reader lacks.
  // Turn-based flow keeps it simple: we pause readline while a turn runs so its input echo
  // never fights the live spinner, then re-prompt. Type-ahead is buffered by the TTY.
  const { createInterface } = await import("node:readline");
  const { LAYERS, ROLE_NAMES } = await import("./roles");
  const { BEHAVIORS } = await import("./stub-agent");
  const { completeArg } = await import("./complete");
  // Tab-completion: command head from the single command source, plus first-argument values
  // for the commands that have a fixed choice set (layers, roles, behaviors).
  const cmdNames = replCommandNames();
  const argMap: Record<string, string[]> = {
    "/layer": LAYERS.map((l) => l.name),
    "/as": [...ROLE_NAMES],
    "/behavior": Object.keys(BEHAVIORS),
  };
  const completer = (line: string): [string[], string] => {
    const hits = line.includes(" ") ? completeArg(line, argMap) : completeLine(line, cmdNames);
    return [hits, line];
  };
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true, prompt: "\x1b[2m›\x1b[0m ", completer });
  const PROMPT = "\x1b[2m›\x1b[0m ", CONT = "\x1b[2m…\x1b[0m ";
  const showPrompt = () => { process.stdout.write("\n"); rl.setPrompt(PROMPT); rl.prompt(); };

  // Mid-turn interrupt: while a turn runs we put stdin in raw mode and treat Esc / Ctrl-C as
  // "abort this turn" (claude-code's Esc). Returns a disarm fn that restores cooked mode.
  const armAbort = (): (() => void) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return () => {};
    const wasRaw = stdin.isRaw ?? false;     // readline keeps raw on in terminal mode — restore it,
    stdin.setRawMode?.(true); stdin.resume(); // don't force cooked, or Tab/arrows die after this turn
    const onData = (b: Buffer) => { const s = b.toString(); if (s === "\x1b" || s === "\x03") r.abort(); };
    stdin.on("data", onData);
    return () => { stdin.off("data", onData); stdin.setRawMode?.(wasRaw); };
  };
  const runHandle = async (input: string) => {
    const disarm = armAbort();
    try { await r.handle(input); } finally { disarm(); }
  };

  // claude-code-style picker (like /mcp, /plugin): a bottom panel you arrow through. Bare
  // `/layer`, `/as` on a TTY open one; the pure render/decode/reduce live in
  // menu.ts, this is just the raw-mode stdin loop. Returns the chosen index, or null on Esc.
  const { renderMenu, decodeKey, menuReduce } = await import("./menu");
  const pickFrom = (title: string, items: { label: string; hint?: string }[]): Promise<number | null> => {
    const stdin = process.stdin;
    let cursor = 0, count = 0;
    const draw = (first: boolean) => {
      const lines = renderMenu(title, items, cursor);
      if (!first) process.stdout.write(`\x1b[${count}A`);                 // move up to panel top
      process.stdout.write("\r" + lines.map((l) => `\x1b[2K${l}`).join("\n"));
      count = lines.length - 1;
    };
    process.stdout.write("\n");
    draw(true);
    const wasRaw = stdin.isRaw ?? false;     // restore readline's prior raw mode (don't force cooked)
    stdin.setRawMode?.(true);
    stdin.resume();
    return new Promise<number | null>((resolve) => {
      const onData = (buf: Buffer) => {
        const res = menuReduce(cursor, items.length, decodeKey(buf.toString()));
        cursor = res.cursor;
        if (!res.done) { draw(false); return; }
        stdin.off("data", onData);
        stdin.setRawMode?.(wasRaw);
        process.stdout.write(`\x1b[${count}A\r\x1b[0J`);                  // erase the panel
        resolve(res.done === "select" ? cursor : null);
      };
      stdin.on("data", onData);
    });
  };
  const isTTY = () => !!process.stdin.isTTY;
  const pickLayer = () => pickFrom("Pick a channel layer:", LAYERS.map((l) => ({ label: l.name, hint: l.desc })));
  const pickRole = () => pickFrom("Act as which role:", ROLE_NAMES.map((rname) => ({ label: rname })));

  // Multi-line input two ways:
  //  - explicit: a trailing backslash continues onto a `…` line.
  //  - paste: a multi-line paste arrives as several `line` events back-to-back (Bun's readline
  //    strips the bracketed-paste markers but doesn't coalesce). We debounce: lines landing
  //    within BURST_MS of each other are joined into one message. A human can't press Enter
  //    twice that fast, so typed lines submit individually; a paste burst becomes one message.
  const BURST_MS = 8;
  let buffer = "";
  let sigintPending = false;
  let burst: string[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();

  const submit = (full: string) => {
    chain = chain.then(async () => {
      rl.pause();
      const t = full.trim();
      try {
        if (t === "/layer" && isTTY()) {
          const pick = await pickLayer();
          if (pick !== null) { const cmd = `/layer ${LAYERS[pick]!.name}`; term.print(`${PROMPT}${cmd}`); await runHandle(cmd); }
        } else if (t === "/as" && isTTY()) {
          const pick = await pickRole();
          if (pick !== null) { const cmd = `/as ${ROLE_NAMES[pick]}`; term.print(`${PROMPT}${cmd}`); await runHandle(cmd); }
        } else if (t) {
          await runHandle(full);
        }
      } catch (e) { term.print(`! ${(e as Error).message}`); }
      rl.resume();
      showPrompt();
    });
  };

  rl.on("line", (line) => {
    sigintPending = false;          // any submitted line disarms the Ctrl-C-again-to-exit prompt
    if (line.endsWith("\\")) { buffer += line.slice(0, -1) + "\n"; rl.setPrompt(CONT); rl.prompt(); return; }
    burst.push(line);
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      const full = buffer + burst.join("\n");
      buffer = ""; burst = []; flushTimer = undefined;
      submit(full);
    }, BURST_MS);
  });
  // Ctrl-C at the prompt: clear the typed line, or (empty line) warn then exit on a second
  // press — shell/claude-code style. Mid-turn Ctrl-C is caught in raw mode by armAbort instead.
  rl.on("SIGINT", () => {
    const { action, pending } = sigintAction(sigintPending, rl.line.length);
    sigintPending = pending;
    if (action === "clear") { (rl as any).line = ""; (rl as any).cursor = 0; process.stdout.write("\r\x1b[2K"); rl.prompt(); }
    else if (action === "warn") { process.stdout.write("\n\x1b[2m(press Ctrl-C again to exit)\x1b[0m\n"); rl.prompt(); }
    else rl.close();
  });
  rl.on("close", async () => {                // Ctrl-D / EOF
    clearInterval(spin);
    await r.dispose();
    process.exit(0);
  });
  showPrompt();
}
