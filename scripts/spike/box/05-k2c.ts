/**
 * K2c: the same real agent task, with a real model, on plain runc and in the design's gVisor box. Run as root in the
 * Linux VM, from this directory's parent:
 *
 *     sudo env PROFILE=/path/to/provider.env bun scripts/spike/box/05-k2c.ts [label]
 *
 * PROFILE is a dotenv file with ANTHROPIC_BASE_URL (an Anthropic-compatible endpoint), ANTHROPIC_AUTH_TOKEN (the
 * credential, form B) and optionally model names. The token is read into this process and nowhere else:
 *   C0  docker run (runc), host network, the real token in the container's environment (the unboxed baseline)
 *   C1  runsc, --network none, a PLACEHOLDER token, box-init relays to the provider proxy on a Unix socket, which adds
 *       the real token (the design)
 * Nothing is printed or saved that contains the token: results hold timings and counts only, and the script scans its
 * own output before it finishes. Each run gets a fresh workspace (a small Python project with three bugs and a tree
 * of small files) and a fresh agent home; success is judged by running the project's tests on the host afterwards.
 * RUNS (default 3 per configuration), TASK_TIMEOUT_MS (default 360000).
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startEgressProxy, startProviderProxy } from "./lib/servers";

const HERE = import.meta.dir;
const SPIKE = process.env.SPIKE ?? "/var/lib/slaude-spike";
const RS = `${SPIKE}/rs`;
const ROOTFS = `${SPIKE}/bench-root`;
const LABEL = process.argv[2] ?? "vm";
const RUNS = Number(process.env.RUNS ?? 3);
const TIMEOUT = Number(process.env.TASK_TIMEOUT_MS ?? 360_000);
const OUT = join(HERE, "results", `05-k2c.${LABEL}.json`);
const PLACEHOLDER = "PLACEHOLDER-auth-token-PLACEHOLDER";

const profilePath = process.env.PROFILE ?? "";
if (!profilePath) throw new Error("PROFILE is not set (a dotenv file with the provider's base URL and token)");
const profile: Record<string, string> = {};
for (const line of readFileSync(profilePath, "utf8").split("\n")) {
  const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
  if (!m) continue;
  profile[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "");
}
const TOKEN = profile.ANTHROPIC_AUTH_TOKEN ?? "";
const UPSTREAM = profile.ANTHROPIC_BASE_URL ?? "";
if (!TOKEN || !UPSTREAM) throw new Error("the profile has no ANTHROPIC_AUTH_TOKEN or no ANTHROPIC_BASE_URL");
// Non-secret settings of the profile (model names, effort) go to the agent in both configurations.
const SETTINGS = Object.entries(profile).filter(([k]) => !["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CCO_CLAUDE_ARGS"].includes(k) && /^(ANTHROPIC_|CLAUDE_CODE_)/.test(k));

const redact = (s: string): string => s.split(TOKEN).join("<redacted>");

function sh(cmd: string, env: Record<string, string> = {}): { code: number; out: string } {
  const r = spawnSync("bash", ["-c", `source ${HERE}/lib.sh; ${cmd}`], { env: { ...process.env, ...env }, encoding: "utf8" });
  return { code: r.status ?? 1, out: redact(`${r.stdout}${r.stderr}`) };
}

/** Empty a directory without replacing it: the sandbox has it bind mounted, and a new directory at the same path is a different one. */
function clearDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const e of readdirSync(dir)) rmSync(join(dir, e), { recursive: true, force: true });
}

/** A small Python project with three bugs, and a tree of small files to give the file system real work. */
function makeWorkspace(ws: string): void {
  clearDir(ws);
  mkdirSync(join(ws, "app"), { recursive: true });
  mkdirSync(join(ws, "tests"), { recursive: true });
  writeFileSync(join(ws, "app", "__init__.py"), "");
  writeFileSync(join(ws, "tests", "__init__.py"), ""); // `unittest discover -s tests -t .` needs the package
  const bugs = new Set([7, 13, 21]);
  const tests: string[] = ["import unittest", "from app import " + Array.from({ length: 30 }, (_, i) => `m${i}`).join(", "), "", "class All(unittest.TestCase):"];
  for (let i = 0; i < 30; i++) {
    writeFileSync(join(ws, "app", `m${i}.py`), `def f(x):\n    return x + ${i}${bugs.has(i) ? " + 1" : ""}\n`);
    tests.push(`    def test_${i}(self):\n        self.assertEqual(m${i}.f(10), ${10 + i})`);
  }
  tests.push("", 'if __name__ == "__main__":', "    unittest.main()", "");
  writeFileSync(join(ws, "tests", "test_all.py"), tests.join("\n"));
  for (let j = 0; j < 2000; j++) {
    const d = join(ws, "vendor", `pkg${Math.floor(j / 50)}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `f${j}.txt`), `vendored file ${j}\n`);
  }
  sh(`chown -R 1000:1000 ${ws}`);
}

const PROMPT =
  "The Python project in /work has failing tests. Run `python3 -m unittest discover -s tests -t .` in /work, find the bugs in /work/app, " +
  "fix them with minimal edits, and run the tests again until they all pass. Do not touch /work/vendor. Reply with one short line when done.";
const STREAM = process.env.STREAM === "1";
const ARGS = ["-p", PROMPT, "--output-format", STREAM ? "stream-json" : "json", ...(STREAM ? ["--verbose"] : []), "--dangerously-skip-permissions"];

interface Run {
  config: string;
  tools?: string[];
  n: number;
  wallMs: number;
  turns: number | null;
  durationMs: number | null;
  apiMs: number | null;
  isError: boolean | null;
  testsPass: boolean;
  exit: number;
  note: string;
}

function parse(out: string): { num_turns?: number; duration_ms?: number; duration_api_ms?: number; is_error?: boolean } {
  const lines = out.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(lines[i] ?? "");
      if (j && typeof j === "object" && (!STREAM || j.type === "result")) return j;
    } catch {
      /* not a JSON line */
    }
  }
  return {};
}

/** The tool calls of a stream-json run and the start of each result: names, commands and output, nothing else. */
function trace(out: string): string[] {
  const calls: string[] = [];
  const clip = (v: unknown, n: number) => String(typeof v === "string" ? v : JSON.stringify(v ?? "")).replace(/\s+/g, " ").slice(0, n);
  for (const l of out.split("\n")) {
    try {
      const j = JSON.parse(l);
      for (const b of j?.message?.content ?? []) {
        if (b?.type === "tool_use") calls.push(`${b.name}: ${clip(b.input?.command ?? b.input?.file_path ?? b.input?.pattern ?? "", 110)}`);
        if (b?.type === "tool_result") calls.push(`   -> ${b.is_error ? "ERROR " : ""}${clip(b.content, 140)}`);
      }
    } catch {
      /* skip */
    }
  }
  return calls.map(redact);
}

function runProcess(cmd: string, args: string[], env: Record<string, string>, onTimeout?: () => void): Promise<{ code: number; out: string; err: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out: redact(out), err: redact(err), ms: Date.now() - t0 });
    };
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    // Killing the client of a sandbox's exec does not end what runs in the sandbox, and its pipes can stay open: end the
    // sandbox's process through the runtime, and give up on the pipes after a grace period.
    const timer = setTimeout(() => {
      onTimeout?.();
      p.kill("SIGKILL");
      setTimeout(() => finish(124), 5000);
    }, TIMEOUT);
    p.on("close", (code) => finish(code ?? 1));
  });
}

const BASE = `${SPIKE}/k2c`;
const WS = `${BASE}/ws`;
const HOME = `${BASE}/home`;
const RUN = `${BASE}/run`;
const OV = `${BASE}/ov`;

function freshState(): void {
  makeWorkspace(WS);
  clearDir(HOME);
  sh(`chown 1000:1000 ${HOME} ${WS}`);
}

function testsPass(): boolean {
  return spawnSync("python3", ["-m", "unittest", "discover", "-s", "tests", "-t", "."], { cwd: WS, encoding: "utf8" }).status === 0;
}

const results: Run[] = [];

async function c0(n: number): Promise<Run> {
  freshState();
  const envFlags = ["-e", "ANTHROPIC_AUTH_TOKEN", "-e", "ANTHROPIC_BASE_URL", ...SETTINGS.flatMap(([k]) => ["-e", k])];
  const r = await runProcess(
    "docker",
    ["run", "--rm", "--user", "1000:1000", "--network", "host", "-v", `${WS}:/work`, "-v", `${HOME}:/home/agent`, "-w", "/work",
     "-e", "HOME=/home/agent", "-e", "CLAUDE_CONFIG_DIR=/home/agent/.claude", "-e", "DISABLE_AUTOUPDATER=1", "-e", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
     ...envFlags, "slaude-bench", "claude", ...ARGS],
    { ...process.env as Record<string, string>, ANTHROPIC_AUTH_TOKEN: TOKEN, ANTHROPIC_BASE_URL: UPSTREAM, ...Object.fromEntries(SETTINGS) },
  );
  const j = parse(r.out);
  return { config: "C0 runc", ...(STREAM ? { tools: trace(r.out) } : {}), n, wallMs: r.ms, turns: j.num_turns ?? null, durationMs: j.duration_ms ?? null, apiMs: j.duration_api_ms ?? null, isError: j.is_error ?? null, testsPass: testsPass(), exit: r.code, note: r.code === 0 ? "" : r.err.slice(0, 200) };
}

async function c1(n: number): Promise<Run> {
  freshState();
  const env = [
    "PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/home/agent", "CLAUDE_CONFIG_DIR=/home/agent/.claude",
    "ANTHROPIC_BASE_URL=http://127.0.0.1:3129", "HTTPS_PROXY=http://127.0.0.1:3128", "HTTP_PROXY=http://127.0.0.1:3128", "NO_PROXY=127.0.0.1,localhost",
    "DISABLE_AUTOUPDATER=1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1", `ANTHROPIC_AUTH_TOKEN=${PLACEHOLDER}`,
    ...SETTINGS.map(([k, v]) => `${k}=${v}`),
  ];
  const r = await runProcess("runsc", ["--root", RS, "exec", "--user", "1000:1000", "--cwd", "/work", "k2c", "/usr/bin/env", "-i", ...env, "claude", ...ARGS], process.env as Record<string, string>, () => spawnSync("runsc", ["--root", RS, "exec", "k2c", "/usr/bin/pkill", "-KILL", "-u", "1000"]));
  const j = parse(r.out);
  return { config: "C1 gvisor box", ...(STREAM ? { tools: trace(r.out) } : {}), n, wallMs: r.ms, turns: j.num_turns ?? null, durationMs: j.duration_ms ?? null, apiMs: j.duration_api_ms ?? null, isError: j.is_error ?? null, testsPass: testsPass(), exit: r.code, note: r.code === 0 ? "" : r.err.slice(0, 200) };
}

// The sandbox: --network none, the workspace and home bind mounted, box-init relaying to the two sockets.
rmSync(BASE, { recursive: true, force: true });
for (const d of ["ws", "home", "run", "ov"]) mkdirSync(`${BASE}/${d}`, { recursive: true });
chmodSync(RUN, 0o755);
sh(`runsc --root ${RS} delete -force k2c 2>/dev/null; true`);
const proxy = startProviderProxy(`${RUN}/llm.sock`, UPSTREAM, "B", () => TOKEN);
const egress = startEgressProxy(`${RUN}/egress.sock`);
const mk = sh(`ROOTFS=${ROOTFS} BOX_INIT=1 mkspec k2c ${HOME} ${WS} ${RUN} && runsc --root ${RS} --platform systrap --network none --host-uds open --overlay2 "root:dir=${OV},size=2g" run --detach --bundle ${SPIKE}/specs/k2c k2c </dev/null >${BASE}/run.log 2>&1`);
if (mk.code !== 0) {
  console.log(`RESULT k2c-sandbox | FAIL | ${mk.out.slice(0, 300)}`);
  proxy.stop();
  egress.stop();
  process.exit(1);
}

try {
  for (let i = 1; i <= RUNS; i++) {
    for (const f of (process.env.CONFIGS ?? "c0,c1").split(",").map((c) => (c === "c0" ? c0 : c1))) {
      const r = await f(i);
      results.push(r);
      console.log(`RESULT k2c-run | INFO | ${r.config} run ${r.n}: wall ${r.wallMs} ms, api ${r.apiMs} ms, turns ${r.turns}, tests ${r.testsPass ? "pass" : "FAIL"}, exit ${r.exit}${r.note ? `, ${r.note}` : ""}`);
    }
  }
} finally {
  sh(`runsc --root ${RS} delete -force k2c 2>/dev/null; true`);
  proxy.stop();
  egress.stop();
}

const med = (a: number[]): number => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]! : NaN);
const summary: Record<string, unknown> = {};
for (const config of ["C0 runc", "C1 gvisor box"]) {
  const rs = results.filter((r) => r.config === config && r.testsPass && r.exit === 0);
  summary[config] = {
    runs: results.filter((r) => r.config === config).length,
    succeeded: rs.length,
    medianWallMs: med(rs.map((r) => r.wallMs)),
    medianApiMs: med(rs.flatMap((r) => (r.apiMs === null ? [] : [r.apiMs]))),
    medianTurns: med(rs.flatMap((r) => (r.turns === null ? [] : [r.turns]))),
    // What is not the model's time: the CLI's own work, the tools, the sandbox. The number that isolates the sandbox.
    medianNonModelMs: med(rs.flatMap((r) => (r.apiMs === null ? [] : [r.wallMs - r.apiMs]))),
    medianWallPerTurnMs: med(rs.flatMap((r) => (r.turns ? [Math.round(r.wallMs / r.turns)] : []))),
  };
}
const c0m = (summary["C0 runc"] as { medianWallMs: number }).medianWallMs;
const c1m = (summary["C1 gvisor box"] as { medianWallMs: number }).medianWallMs;
console.log(`RESULT k2c | INFO | median wall: runc ${c0m} ms, gvisor box ${c1m} ms, ratio ${(c1m / c0m).toFixed(2)}x (K2c kills above 1.25x); detail ${JSON.stringify(summary)}`);
for (const [c, v] of Object.entries(summary)) console.log(`RESULT k2c-nonmodel | INFO | ${c}: ${JSON.stringify(v)}`);

const body = JSON.stringify({ label: LABEL, finished: new Date().toISOString(), runsPerConfig: RUNS, summary, results }, null, 1);
if (body.includes(TOKEN)) throw new Error("the results hold the token: not written");
mkdirSync(join(HERE, "results"), { recursive: true });
writeFileSync(OUT, body);
console.log(`done: ${OUT}`);
