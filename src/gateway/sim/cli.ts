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
  const { Screen } = await import("./screen");
  const { decodeKeys } = await import("./keys");
  const { LineEditor } = await import("./editor");
  const { completeLine, completeArg } = await import("./complete");
  const { sigintAction } = await import("./interrupt");
  const { LAYERS, ROLE_NAMES } = await import("./roles");
  const { BEHAVIORS } = await import("./stub-agent");
  const { renderMenu, decodeKey, menuReduce } = await import("./menu");

  const r = new ReplController(agentMode, soulMd);
  const screen = new Screen((s) => process.stdout.write(s), () => ({
    rows: process.stdout.rows ?? 24,
    cols: process.stdout.columns ?? 80,
  }));
  const editor = new LineEditor();
  const paint = () => { const v = editor.view(); screen.setInput(v.text, v.cursor); };

  r.onOutput((l) => screen.print(l));
  r.onStatus((l) => screen.setStatus(l));
  const spin = setInterval(() => screen.tick(), 120);

  // Tab-completion sources.
  const cmdNames = replCommandNames();
  const argMap: Record<string, string[]> = {
    "/layer": LAYERS.map((l) => l.name),
    "/as": [...ROLE_NAMES],
    "/behavior": Object.keys(BEHAVIORS),
  };
  const complete = (line: string): string | null => {
    const hits = line.includes(" ") ? completeArg(line, argMap) : completeLine(line, cmdNames);
    return hits.length === 1 ? hits[0]! : null;   // single hit → apply; ambiguous → leave as-is
  };

  // Intro.
  const modeLabel = agentMode === "real" ? "live agent" : "stub";
  const tail = `a/d/A (or 1/2/3) answers gates · /help · Ctrl-D quits.${verbose ? "" : "  (--verbose for infra logs)"}`;
  screen.setHint(tail);
  screen.print(`\x1b[1m✻ slaude sim\x1b[0m  \x1b[2m${modeLabel}\x1b[0m`);
  if (shared) {
    await r.startShared();
    screen.print(`\x1b[2mshared config (real ~/.slaude, state under sim/)\x1b[0m`);
  } else {
    await r.startDefault();
    screen.print(`\x1b[2m${soulPath ? `soul=${soulPath} · ` : ""}fixture — /layer · /as · /behavior, then chat.\x1b[0m`);
  }
  paint();

  const stdin = process.stdin;
  stdin.setRawMode?.(true);
  stdin.resume();
  process.stdout.write("\x1b[?2004h");   // enable bracketed paste

  const onResize = () => screen.resize();
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;        // idempotent: may run via quit() AND the exit hook
    cleanedUp = true;
    clearInterval(spin);
    process.stdout.off("resize", onResize);
    process.stdout.write("\x1b[?2004l");
    screen.restore();
    stdin.setRawMode?.(false);
  };
  const quit = async () => { cleanup(); await r.dispose(); process.exit(0); };
  // Safety net: any exit (incl. an uncaught crash) restores the terminal so the user is never
  // left in raw mode with a stuck scroll region. `process.on("exit")` must be synchronous —
  // cleanup() only does sync writes + setRawMode, which is fine here.
  process.on("exit", cleanup);

  process.stdout.on("resize", onResize);

  // Turn execution: a running turn owns the keyboard for mid-turn abort (Esc / Ctrl-C).
  let busy = false;
  let modal = false;          // a picker owns the keyboard — main handler stands down
  let sigintPending = false;

  const runTurn = async (input: string) => {
    busy = true;
    const onAbortKey = (b: Buffer) => { const s = b.toString(); if (s === "\x1b" || s === "\x03") r.abort(); };
    stdin.on("data", onAbortKey);
    try { await r.handle(input); }
    catch (e) { screen.print(`! ${(e as Error).message}`); }
    finally { stdin.off("data", onAbortKey); busy = false; paint(); }
  };

  // Bare `/layer` / `/as` open a picker (claude-code /mcp-style): an in-place bottom-sheet
  // drawn in the footer above the box via screen.setPanel — arrow keys redraw it in place,
  // no scrollback spam. Esc cancels, Enter selects.
  const pickFrom = (title: string, items: { label: string; hint?: string }[]): Promise<number | null> =>
    new Promise((resolve) => {
      modal = true;             // gate the main handler while the picker owns keys
      let cursor = 0;
      const draw = () => screen.setPanel(renderMenu(title, items, cursor));
      draw();
      const onKey = (b: Buffer) => {
        const res = menuReduce(cursor, items.length, decodeKey(b.toString()));
        cursor = res.cursor;
        if (!res.done) { draw(); return; }
        stdin.off("data", onKey);
        screen.setPanel(null);  // close the sheet
        modal = false;
        resolve(res.done === "select" ? cursor : null);
      };
      stdin.on("data", onKey);
    });

  // `/help` opens a scrollable bottom-sheet (↑/↓ scroll, any of Esc/Enter/q close).
  const showHelp = (lines: string[]): Promise<void> =>
    new Promise((resolve) => {
      modal = true;
      let off = 0;
      // Body rows the panel can show = terminal minus box(3) + hint(1) + 1 reserved scroll row
      // + 1 for our own header line. Matches layoutFooter's panelBudget so nothing is clipped.
      const cap = () => Math.max(3, (process.stdout.rows ?? 24) - 6);
      const maxOff = () => Math.max(0, lines.length - cap());
      const draw = () => {
        const more = lines.length > cap();
        const head = `\x1b[1mhelp\x1b[0m${more ? `  \x1b[2m↑/↓ scroll · Esc to close (${off + 1}-${Math.min(off + cap(), lines.length)}/${lines.length})\x1b[0m` : "  \x1b[2mEsc to close\x1b[0m"}`;
        screen.setPanel([head, ...lines.slice(off, off + cap())]);
      };
      draw();
      const onKey = (b: Buffer) => {
        const k = decodeKey(b.toString());
        if (k === "up") { off = Math.max(0, off - 1); draw(); return; }
        if (k === "down") { off = Math.min(maxOff(), off + 1); draw(); return; }
        if (k === "enter" || k === "esc" || k === "other") { // 'other' covers q/space/any
          stdin.off("data", onKey);
          screen.setPanel(null);
          modal = false;
          resolve();
        }
      };
      stdin.on("data", onKey);
    });

  const submit = async (full: string) => {
    const t = full.trim();
    if (t === "/layer") {
      const pick = await pickFrom("Pick a channel layer:", LAYERS.map((l) => ({ label: l.name, hint: l.desc })));
      if (pick !== null) await runTurn(`/layer ${LAYERS[pick]!.name}`);
      else paint();
    } else if (t === "/as") {
      const pick = await pickFrom("Act as which role:", ROLE_NAMES.map((n) => ({ label: n })));
      if (pick !== null) await runTurn(`/as ${ROLE_NAMES[pick]}`);
      else paint();
    } else if (t === "/help") {
      await showHelp(r.helpLines());
      paint();
    } else if (t) {
      await runTurn(full);
    } else { paint(); }
  };

  stdin.on("data", (buf: Buffer) => {
    if (busy || modal) return;                          // a turn or picker owns the keyboard
    for (const k of decodeKeys(buf.toString())) {
      const a = editor.handle(k);
      if (a.type === "render" || a.type === "none") { sigintPending = false; paint(); }
      // submit/eof hand control to an async path; stop draining this chunk so trailing keys
      // aren't processed before `busy`/`modal` latch (e.g. a paste burst ending in Enter).
      else if (a.type === "submit") { sigintPending = false; paint(); void submit(a.text); break; }
      else if (a.type === "complete") { const c = complete(a.line); if (c) editor.applyCompletion(c); paint(); }
      else if (a.type === "eof") { void quit(); break; }
      else if (a.type === "sigint") {
        const { action, pending } = sigintAction(sigintPending, editor.view().text.length);
        sigintPending = pending;
        if (action === "clear") { editor.applyCompletion(""); paint(); }
        else if (action === "warn") { screen.print("\x1b[2m(press Ctrl-C again to exit)\x1b[0m"); paint(); }
        else void quit();
      }
    }
  });
}
