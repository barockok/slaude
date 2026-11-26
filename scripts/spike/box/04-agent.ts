/**
 * Spike 4: the agent inside the sandbox, driven by the Agent SDK through `spawnClaudeCodeProcess`
 * backed by `runsc exec` with piped stdio. Run as root in the Linux VM (after 02-setup-bench.sh):
 *     sudo bun scripts/spike/box/04-agent.ts [label]           ONLY=case1,case2 to run a subset
 * No model credential exists: the model is the scripted fake upstream behind the provider proxy.
 * Home and workspace are bind mounted at the SAME path inside and outside (the transcript path
 * contract); the plugin directory is a read-only bind mount.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync, copyFileSync, cpSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { startEgressProxy, startFakeUpstream, startProviderProxy } from "./lib/servers";

const HERE = import.meta.dir;
const SPIKE = process.env.SPIKE ?? "/var/lib/slaude-spike";
const SDK_DIR = process.env.SDK_DIR ?? `${SPIKE}/sdk/node_modules`;
const RS = `${SPIKE}/rs`;
const LABEL = process.argv[2] ?? "vm";
const ONLY = (process.env.ONLY ?? "").split(",").filter(Boolean);
const W = `${SPIKE}/w4`;
const NAME = "agent4";
const HOST_CLAUDE = `${SDK_DIR}/@anthropic-ai/claude-agent-sdk-linux-arm64/claude`;

const sdk: typeof import("@anthropic-ai/claude-agent-sdk") = await import(`${SDK_DIR}/@anthropic-ai/claude-agent-sdk/sdk.mjs`);
const { z } = (await import(`${SDK_DIR}/zod/index.js`)) as typeof import("zod");
const { query, createSdkMcpServer, tool } = sdk;

const PLACEHOLDER = "sk-ant-api03-PLACEHOLDERPLACEHOLDERPLACEHOLDERPLACEHOLDERPLACEHOLDER-AAAAAA";
const REAL = `REALCRED-A-${crypto.randomUUID()}`;
const results: Array<{ name: string; status: "PASS" | "FAIL" | "INFO"; detail: string; ms?: number }> = [];
function rec(name: string, status: "PASS" | "FAIL" | "INFO", detail: string, ms?: number) {
  results.push({ name, status, detail, ms });
  console.log(`RESULT ${name} | ${status} | ${ms ?? "-"} ms | ${detail.replace(/\n/g, " ").slice(0, 380)}`);
}
function sh(cmd: string, env: Record<string, string> = {}): { code: number; out: string } {
  const p = spawnSync("bash", ["-c", `source ${HERE}/lib.sh; ${cmd}`], { env: { ...process.env, ...env }, encoding: "utf8" });
  return { code: p.status ?? 1, out: (p.stdout ?? "") + (p.stderr ?? "") };
}
const rsc = (...a: string[]) => spawnSync("runsc", ["--root", RS, ...a], { encoding: "utf8" });
const want = (n: string) => ONLY.length === 0 || ONLY.includes(n);

// ---------------------------------------------------------------- environment
rmSync(W, { recursive: true, force: true });
for (const d of ["home", "ws", "run", "ov", "plugins"]) mkdirSync(`${W}/${d}`, { recursive: true });
cpSync(`${HERE}/fixtures/plugin`, `${W}/plugins/spike`, { recursive: true });
chmodSync(`${W}/plugins/spike/hooks/h.sh`, 0o755);
copyFileSync(`${HERE}/fixtures/stdio-mcp.js`, `${W}/ws/stdio-mcp.js`);
sh(`chown -R 1000:1000 ${W}/home ${W}/ws`);
const HOME = `${W}/home`;
const WS = `${W}/ws`;

const upstream = startFakeUpstream("A", REAL, PLACEHOLDER);
const proxy = startProviderProxy(`${W}/run/llm.sock`, upstream.url, "A", () => REAL);
const allow: string[] = [];
const egress = startEgressProxy(`${W}/run/egress.sock`, allow);

sh(`runsc --root ${RS} delete -force ${NAME} 2>/dev/null; true`);
const st = sh(`ROOTFS=${SPIKE}/bench-root BOX_INIT=1 SAMEPATH=1 EXTRA_MOUNTS="${W}/plugins:/plugins" mkspec ${NAME} ${HOME} ${WS} ${W}/run && runsc --root ${RS} --platform systrap --network none --host-uds open --overlay2 "root:dir=${W}/ov,size=4g" run --detach --bundle ${SPIKE}/specs/${NAME} ${NAME} </dev/null >${W}/run.log 2>&1`);
if (st.code !== 0) {
  rec("sandbox-start", "FAIL", st.out);
  process.exit(1);
}
await Bun.sleep(800);

// ---------------------------------------------------------------- the spawn hook
type KillMode = "naive" | "pidkill" | "newpidns"; // naive: kill only the exec client; pidkill: also runsc kill --pid; newpidns: exec in a new pid namespace plus runsc kill --pid
let seq = 0;
function makeSpawn(mode: KillMode, stderrSink?: string[]) {
  return (o: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined>; signal: AbortSignal }) => {
    const pidFile = `${W}/pid-${seq++}`;
    const env = Object.entries(o.env).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`);
    const cmd = o.command === HOST_CLAUDE || o.command.endsWith("/claude") ? "/usr/local/bin/claude" : o.command;
    const argv = ["--root", RS, "exec", "--user", "1000:1000", "--cwd", o.cwd ?? WS, "--internal-pid-file", pidFile, ...(mode === "newpidns" ? ["--new-pidns"] : []), NAME, "/usr/bin/env", "-i", ...env, cmd, ...o.args];
    const child: ChildProcess = spawn("runsc", argv, { stdio: ["pipe", "pipe", "pipe"] });
    child.stderr?.on("data", (d) => stderrSink?.push(String(d)));
    const origKill = child.kill.bind(child);
    child.kill = ((sig?: NodeJS.Signals | number) => {
      if (mode !== "naive" && existsSync(pidFile)) {
        const pid = readFileSync(pidFile, "utf8").trim();
        if (pid) spawnSync("runsc", ["--root", RS, "kill", "--pid", pid, NAME, sig === "SIGKILL" ? "KILL" : "TERM"]);
      }
      return origKill(sig);
    }) as ChildProcess["kill"];
    // the SDK's forwarded abort signal fires after its own stdin-EOF grace window
    o.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    return child;
  };
}

const baseEnv = (extra: Record<string, string> = {}) => ({
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME,
  CLAUDE_CONFIG_DIR: `${HOME}/.claude`,
  ANTHROPIC_API_KEY: PLACEHOLDER,
  ANTHROPIC_BASE_URL: "http://127.0.0.1:3129",
  HTTPS_PROXY: "http://127.0.0.1:3128",
  HTTP_PROXY: "http://127.0.0.1:3128",
  NO_PROXY: "127.0.0.1,localhost",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
  ...extra,
});

interface Run {
  result: string | null;
  isError: boolean;
  sessionId: string | null;
  init: Record<string, unknown> | null;
  ms: number;
  upstreamReqs: number;
  stderr: string;
  error?: string;
}

async function run(prompt: string, opts: Record<string, unknown> = {}, mode: KillMode = "newpidns", ac = new AbortController()): Promise<Run> {
  const before = upstream.seen.length;
  const stderr: string[] = [];
  const t0 = Date.now();
  let result: string | null = null;
  let isError = false;
  let sessionId: string | null = null;
  let init: Record<string, unknown> | null = null;
  let error: string | undefined;
  try {
    const q = query({
      prompt,
      options: {
        cwd: WS,
        abortController: ac,
        model: "claude-test",
        pathToClaudeCodeExecutable: HOST_CLAUDE,
        spawnClaudeCodeProcess: makeSpawn(mode, stderr) as never,
        settingSources: [],
        env: baseEnv(),
        stderr: (d: string) => stderr.push(d),
        ...opts,
      } as never,
    });
    for await (const m of q) {
      const mm = m as Record<string, unknown>;
      if (mm.type === "system" && mm.subtype === "init") init = mm;
      if (mm.type === "result") {
        isError = !!mm.is_error;
        result = mm.subtype === "success" ? (mm.result as string) : String(mm.subtype);
        sessionId = (mm.session_id as string) ?? null;
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return { result, isError, sessionId, init, ms: Date.now() - t0, upstreamReqs: upstream.seen.length - before, stderr: stderr.join("").slice(0, 400), error };
}

const touched = () => existsSync(`${WS}/touched.marker`);
const clearMarkers = () => { rmSync(`${WS}/touched.marker`, { force: true }); rmSync(`${WS}/hook.marker`, { force: true }); };
const sandboxProcs = (pattern: string) => (rsc("ps", NAME).stdout ?? "").split("\n").filter((l) => l.includes(pattern)).length;

// ---------------------------------------------------------------- cases
if (want("toolloop")) {
  const r = await run("TOOLLOOP please", { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, tools: ["Bash"] });
  rec("sdk/tool-loop", r.result === "loop done" && !r.isError ? "PASS" : "FAIL", `result=${r.result} reqs=${r.upstreamReqs} ${r.error ?? r.stderr}`, r.ms);
  (globalThis as Record<string, unknown>).loopSession = r.sessionId;
}

if (want("hook-deny")) {
  clearMarkers();
  let calls = 0;
  const r = await run("TOUCH now", {
    permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, tools: ["Bash"],
    hooks: { PreToolUse: [{ hooks: [async () => { calls++; return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "held: denied by spike" } }; }] }] },
  });
  rec("sdk/pretooluse-hook-deny", calls >= 1 && !touched() ? "PASS" : "FAIL", `hook calls=${calls} marker created=${touched()} result=${r.result} ${r.error ?? ""}`, r.ms);
}

if (want("canusetool")) {
  clearMarkers();
  let asked = 0;
  let r = await run("TOUCH now", { permissionMode: "default", tools: ["Bash"], canUseTool: async (_n: string, input: Record<string, unknown>) => { asked++; return { behavior: "allow", updatedInput: input }; } });
  rec("sdk/canusetool-allow", asked >= 1 && touched() ? "PASS" : "FAIL", `asked=${asked} marker created=${touched()} result=${r.result} ${r.error ?? r.stderr}`, r.ms);
  clearMarkers();
  asked = 0;
  r = await run("TOUCH now", { permissionMode: "default", tools: ["Bash"], canUseTool: async () => { asked++; return { behavior: "deny", message: "card says no" }; } });
  rec("sdk/canusetool-deny", asked >= 1 && !touched() ? "PASS" : "FAIL", `asked=${asked} marker created=${touched()} result=${r.result}`, r.ms);
}

if (want("inproc-mcp")) {
  let called = 0;
  const server = createSdkMcpServer({
    name: "spike",
    version: "1.0.0",
    tools: [tool("echo", "echo text", { text: z.string() }, async (a: { text: string }) => { called++; return { content: [{ type: "text", text: `inproc:${a.text}` }] }; })],
  });
  const r = await run("MCPCALL now", { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, mcpServers: { spike: server } });
  rec("sdk/in-process-mcp", called === 1 && r.result === "mcpcall done" ? "PASS" : "FAIL", `handler calls=${called} result=${r.result} ${r.error ?? r.stderr}`, r.ms);
}

if (want("stdio-mcp")) {
  const r = await run("STDIOMCP now", { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, mcpServers: { stdiospike: { type: "stdio", command: "node", args: [`${WS}/stdio-mcp.js`] } } });
  const tr = sh(`grep -rl "echo:hello-stdio" ${HOME}/.claude/projects | head -1`).out.trim();
  const mcpStatus = JSON.stringify((r.init?.mcp_servers as unknown) ?? null);
  rec("sdk/stdio-mcp-in-sandbox", r.result === "stdiomcp done" && tr !== "" ? "PASS" : "FAIL", `result=${r.result} tool result found in transcript=${tr !== ""} mcp_servers=${mcpStatus} ${r.error ?? r.stderr}`, r.ms);
}

if (want("plugin")) {
  clearMarkers();
  const r = await run("TOUCH now", {
    permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, tools: ["Bash"], plugins: [{ type: "local", path: "/plugins/spike" }],
    env: baseEnv({ SPIKE_HOOK_MARKER: `${WS}/hook.marker` }),
  });
  const skills = JSON.stringify((r.init?.skills as unknown) ?? (r.init?.slash_commands as unknown) ?? null);
  const hook = existsSync(`${WS}/hook.marker`) ? readFileSync(`${WS}/hook.marker`, "utf8").trim() : "";
  const ro = spawnSync("runsc", ["--root", RS, "exec", "--user", "1000:1000", NAME, "/bin/sh", "-c", "touch /plugins/spike/x 2>&1; echo rc=$?"], { encoding: "utf8" }).stdout.trim();
  rec("sdk/plugin-skill-from-ro-mount", /spike/.test(skills) ? "PASS" : "FAIL", `init skills/commands mention spike=${/spike/.test(skills)} (${skills.slice(0, 160)}) write to mount: ${ro.replace(/\n/g, " ")}`, r.ms);
  rec("sdk/plugin-hook-runs-inside", hook !== "" ? "PASS" : "FAIL", `marker: ${hook || "(none)"} result=${r.result} ${r.error ?? r.stderr}`, r.ms);
}

if (want("resume")) {
  const sid = (globalThis as Record<string, unknown>).loopSession as string | null;
  if (!sid) rec("sdk/resume", "FAIL", "no session from toolloop (run it first)");
  else {
    const r = await run("TOOLLOOP again", { resume: sid, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, tools: ["Bash"] });
    const enc = WS.replace(/[^a-zA-Z0-9]/g, "-");
    const tfile = `${HOME}/.claude/projects/${enc}/${sid}.jsonl`;
    rec("sdk/resume-same-path-transcript", r.result === "loop done" && existsSync(tfile) && r.upstreamReqs <= 2 ? "PASS" : "FAIL", `result=${r.result} model requests=${r.upstreamReqs} (history loaded when the loop does not rerun) transcript at identical path exists=${existsSync(tfile)} ${tfile}`, r.ms);
  }
}

if (want("abort")) {
  for (const mode of ["naive", "pidkill", "newpidns"] as KillMode[]) {
    const ac = new AbortController();
    const p = run("SLEEP now", { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, tools: ["Bash"] }, mode, ac);
    await Bun.sleep(6000);
    const sleepers = sandboxProcs("sleep");
    const t0 = Date.now();
    ac.abort();
    const r = await p;
    const tAbort = Date.now() - t0;
    await Bun.sleep(2500);
    const left = sandboxProcs("sleep");
    rec(`sdk/abort-mid-turn[${mode}]`, left === 0 && tAbort < 10_000 ? "PASS" : "FAIL", `sleep procs before abort=${sleepers}; query ended ${tAbort} ms after abort; sleep procs left 2.5 s later=${left}; error=${r.error ?? "-"} result=${r.result}`, tAbort);
    spawnSync("runsc", ["--root", RS, "kill", "--all", NAME, "KILL"]);
    await Bun.sleep(300);
    // kill --all removed box-probe init (PID 1) too; the sandbox is gone: restart it for the next mode
    sh(`runsc --root ${RS} delete -force ${NAME} >/dev/null 2>&1; rm -rf ${W}/ov; mkdir -p ${W}/ov; runsc --root ${RS} --platform systrap --network none --host-uds open --overlay2 "root:dir=${W}/ov,size=4g" run --detach --bundle ${SPIKE}/specs/${NAME} ${NAME} </dev/null >${W}/run.log 2>&1`);
    await Bun.sleep(800);
  }
}

if (want("egress")) {
  const penv = ["PATH=/usr/local/bin:/usr/bin:/bin", `HOME=${HOME}`, "HTTPS_PROXY=http://127.0.0.1:3128", "HTTP_PROXY=http://127.0.0.1:3128", "https_proxy=http://127.0.0.1:3128", "http_proxy=http://127.0.0.1:3128", "NO_PROXY=127.0.0.1,localhost", "GOFLAGS=-mod=mod", `GOPATH=${HOME}/go`, `GOCACHE=${HOME}/gocache`, `GOMODCACHE=${HOME}/go/pkg/mod`, "GIT_TERMINAL_PROMPT=0", "npm_config_cache=/tmp/npmc"];
  const tools: Array<[string, string]> = [
    ["curl", "curl -sS -m 25 -o /dev/null -w 'http=%{http_code}' https://example.com"],
    ["git-clone-https", "rm -rf /tmp/hw && git clone --depth 1 https://github.com/octocat/Hello-World.git /tmp/hw && echo cloned"],
    ["npm-view", "npm view left-pad version --fetch-timeout=20000 --fetch-retries=0"],
    ["pip-download", "rm -rf /tmp/pp && python3 -m pip download --no-deps -d /tmp/pp six --retries 0 --timeout 20 && ls /tmp/pp"],
    ["go-mod-download", "rm -rf /tmp/gm && mkdir -p /tmp/gm && cd /tmp/gm && printf 'module spike\\n\\ngo 1.22\\n\\nrequire golang.org/x/text v0.14.0\\n' > go.mod && go mod download golang.org/x/text && echo downloaded"],
  ];
  for (const phase of ["deny-all", "allowlisted"] as const) {
    allow.length = 0;
    if (phase === "allowlisted") allow.push("example.com", "github.com", "registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "proxy.golang.org", "sum.golang.org");
    egress.log.lines.length = 0;
    for (const [name, cmd] of tools) {
      const t0 = Date.now();
      // async: the egress proxy lives in this process, a blocking spawnSync would deadlock it
      const p = Bun.spawn(["runsc", "--root", RS, "exec", "--user", "1000:1000", "--cwd", "/tmp", NAME, "/usr/bin/env", "-i", ...penv, "/bin/sh", "-c", `( ${cmd} ) 2>&1 | tail -4; true`], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const killer = setTimeout(() => p.kill(9), 120_000);
      const stdout = await new Response(p.stdout).text();
      await p.exited;
      clearTimeout(killer);
      const out = stdout.trim().replace(/\n/g, " / ").slice(0, 260);
      const logged = egress.log.lines.filter((l) => /CONNECT|GET|POST/.test(l)).slice(-40);
      const hosts = [...new Set(logged.map((l) => l.split(" ")[2] ?? l))];
      const expectDeny = phase === "deny-all";
      const legible = /egress refused|403|not on this persona/i.test(out);
      const ok = expectDeny ? legible : !/error|fatal|failed/i.test(out) || /cloned|downloaded|http=200|\d+\.\d+|six/.test(out);
      rec(`egress/${phase}/${name}`, ok ? "PASS" : "FAIL", `output: ${out} | proxy log hosts so far: ${hosts.join(",")}`, Date.now() - t0);
    }
    rec(`egress/${phase}/proxy-log`, "INFO", [...new Set(egress.log.lines)].join(" | "));
  }
}

if (want("pack")) {
  const P = `${SPIKE}/pack`;
  rmSync(P, { recursive: true, force: true });
  mkdirSync(`${P}/home`, { recursive: true });
  const gen = sh(`python3 - ${P}/home <<'PY'
import os,sys,random
root=sys.argv[1]; random.seed(3)
words=[("tok%d"%i) for i in range(5000)]
n=0
for d in range(500):
    dd=os.path.join(root,"d%03d"%d,"sub"); os.makedirs(dd,exist_ok=True)
    for f in range(100):
        sz=random.choice([300,1200,2500,4000,9000])
        body=(" ".join(random.choices(words,k=sz//6))+"\\n").encode()
        open(os.path.join(dd,"f%03d.txt"%f),"wb").write(body); n+=1
for i in range(20):
    open(os.path.join(root,"big%02d.bin"%i),"wb").write(os.urandom(5<<20)); n+=1
print("files",n)
PY
du -sm ${P}/home | cut -f1; find ${P}/home -type f | wc -l`);
  console.log(gen.out.trim());
  for (const lvl of [1, 3]) {
    const t0 = Date.now();
    const c = sh(`cd ${P} && tar --use-compress-program="zstd -T0 -${lvl}" -cf pack${lvl}.tar.zst -C home . && ls -l pack${lvl}.tar.zst | awk '{print $5}'`);
    const tc = Date.now() - t0;
    sh(`sync; echo 3 > /proc/sys/vm/drop_caches`);
    rmSync(`${P}/out${lvl}`, { recursive: true, force: true });
    mkdirSync(`${P}/out${lvl}`);
    const t1 = Date.now();
    sh(`tar --use-compress-program="zstd -T0 -d" -xf ${P}/pack${lvl}.tar.zst -C ${P}/out${lvl}`);
    const tx = Date.now() - t1;
    const same = sh(`diff <(cd ${P}/home && find . -type f | sort | head -2000 | xargs sha256sum) <(cd ${P}/out${lvl} && find . -type f | sort | head -2000 | xargs sha256sum) && echo identical-sample`).out.trim().split("\n").pop();
    const n = sh(`find ${P}/out${lvl} -type f | wc -l`).out.trim();
    rec(`pack/50k-files-zstd-${lvl}`, "INFO", `create ${tc} ms, size ${(Number(c.out.trim().split("\n").pop()) / 1048576).toFixed(1)} MB, extract (cold cache, same VM, local disk) ${tx} ms, files extracted ${n}, ${same}`, tc + tx);
  }
  rmSync(P, { recursive: true, force: true });
}

if (want("density")) {
  const cg = `/sys/fs/cgroup/${NAME}`;
  const memMB = (p: string) => (existsSync(`${p}/memory.current`) ? Math.round(Number(readFileSync(`${p}/memory.current`, "utf8")) / 1048576) : -1);
  const idle = memMB(cg);
  // an idle CLI: stream-json input mode, one message processed, then waiting for the next
  const child = makeSpawn("newpidns")({ command: "/usr/local/bin/claude", args: ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"], cwd: WS, env: baseEnv(), signal: new AbortController().signal });
  let out = "";
  let cerr = "";
  child.stdout?.on("data", (d) => (out += d));
  child.stderr?.on("data", (d) => (cerr += d));
  await Bun.sleep(4000);
  const booted = memMB(cg);
  child.stdin?.write(JSON.stringify({ type: "user", message: { role: "user", content: "hello plain" } }) + "\n");
  for (let i = 0; i < 100 && !out.includes('"type":"result"'); i++) await Bun.sleep(100);
  await Bun.sleep(3000);
  const afterTurn = memMB(cg);
  const sbPids = sh(`for p in $(pgrep -f 'runsc-(sandbox|gofer)'); do awk '/VmRSS/{print $2}' /proc/$p/status; done | awk '{s+=$1} END {print s}'`).out.trim();
  rec("density/1-sandbox", "INFO", `[cli produced ${out.length} bytes stdout, stderr: ${cerr.slice(0, 100)}] sandbox cgroup memory.current: idle sandbox ${idle} MB; with CLI started (before any message) ${booted} MB; CLI idle after one turn ${afterTurn} MB; sentry+gofer RSS sum ${Math.round(Number(sbPids) / 1024)} MB`);
  child.kill("SIGTERM");
  await Bun.sleep(500);
  // ten sandboxes, each with an idle CLI after one turn
  const N = 10;
  const kids: ChildProcess[] = [];
  const freeBefore = Number(sh(`free -m | awk '/Mem:/{print $3}'`).out.trim());
  for (let i = 0; i < N; i++) {
    const n = `dens${i}`;
    const D = `${W}/dens/${i}`;
    for (const d of ["home", "ws", "run", "ov"]) mkdirSync(`${D}/${d}`, { recursive: true });
    sh(`chown -R 1000:1000 ${D}/home ${D}/ws`);
    sh(`ROOTFS=${SPIKE}/bench-root BOX_INIT=1 SAMEPATH=1 mkspec ${n} ${D}/home ${D}/ws ${D}/run && runsc --root ${RS} --platform systrap --network none --host-uds open --overlay2 "root:dir=${D}/ov,size=2g" run --detach --bundle ${SPIKE}/specs/${n} ${n} </dev/null >${D}/run.log 2>&1`);
    const pf = startProviderProxy(`${D}/run/llm.sock`, upstream.url, "A", () => REAL);
    void pf;
    const c = spawn("runsc", ["--root", RS, "exec", "--user", "1000:1000", "--cwd", `${D}/ws`, n, "/usr/bin/env", "-i", ...Object.entries(baseEnv({ HOME: `${D}/home`, CLAUDE_CONFIG_DIR: `${D}/home/.claude` })).map(([k, v]) => `${k}=${v}`), "/usr/local/bin/claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"], { stdio: ["pipe", "pipe", "pipe"] });
    c.stdout?.on("data", () => {});
    c.stdin?.write(JSON.stringify({ type: "user", message: { role: "user", content: "hello plain" } }) + "\n");
    kids.push(c);
  }
  await Bun.sleep(12000);
  let total = 0;
  for (let i = 0; i < N; i++) total += memMB(`/sys/fs/cgroup/dens${i}`);
  const freeAfter = Number(sh(`free -m | awk '/Mem:/{print $3}'`).out.trim());
  rec("density/10-sandboxes-with-idle-cli", "INFO", `sum of sandbox cgroup memory.current = ${total} MB (${Math.round(total / N)} MB each); VM used memory delta = ${freeAfter - freeBefore} MB (${Math.round((freeAfter - freeBefore) / N)} MB each; includes page cache of the shared image)`);
  for (const c of kids) c.kill("SIGKILL");
  for (let i = 0; i < N; i++) sh(`runsc --root ${RS} delete -force dens${i} >/dev/null 2>&1; true`);
}

if (ONLY.includes("hold")) await Bun.sleep(900_000);

// ---------------------------------------------------------------- wrap up
const leak = [...upstream.seen].filter((s) => s.placeholderInHeaders).length;
rec("proxy/placeholder-never-upstream", leak === 0 ? "PASS" : "FAIL", `${upstream.seen.length} upstream requests, ${leak} carried the placeholder`);
writeFileSync(join(HERE, "results", `04-agent.${LABEL}.json`), JSON.stringify({ label: LABEL, finished: new Date().toISOString(), results }, null, 1));
sh(`runsc --root ${RS} delete -force ${NAME} >/dev/null 2>&1; true`);
process.exit(0);
