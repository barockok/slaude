/**
 * Spike 3: the provider proxy for every credential form. Run as root in the Linux VM:
 *     sudo bun scripts/spike/box/03-provider.ts [label]        (FORMS=A,B,C by default)
 * For each form it starts a fake upstream that accepts only the REAL credential, a provider proxy on a
 * Unix socket that swaps the credential in, an empty-allowlist egress proxy, and a gVisor sandbox with
 * --network none whose PID 1 (box-probe init) relays 127.0.0.1:3129 and :3128 to those sockets. The real
 * `claude` binary runs inside with a PLACEHOLDER credential. No real credential exists anywhere.
 */
import { $ } from "bun";
import { mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { startEgressProxy, startFakeUpstream, startProviderProxy, type Form } from "./lib/servers";

const HERE = import.meta.dir;
const SPIKE = process.env.SPIKE ?? "/var/lib/slaude-spike";
const RS = `${SPIKE}/rs`;
const LABEL = process.argv[2] ?? "vm";
const FORMS = (process.env.FORMS ?? "A,B,C").split(",") as Form[];
const OUT = join(HERE, "results", `03-provider.${LABEL}.json`);
const ROOTFS = `${SPIKE}/bench-root`;

const PLACEHOLDER: Record<Form, string> = {
  A: "sk-ant-api03-PLACEHOLDERPLACEHOLDERPLACEHOLDERPLACEHOLDERPLACEHOLDER-AAAAAA",
  B: "PLACEHOLDER-auth-token-PLACEHOLDER",
  C: "sk-ant-oat01-PLACEHOLDERPLACEHOLDERPLACEHOLDERPLACEHOLDERPLACEHOLDER-AAAAAA",
};
const CRED_VAR: Record<Form, string> = { A: "ANTHROPIC_API_KEY", B: "ANTHROPIC_AUTH_TOKEN", C: "CLAUDE_CODE_OAUTH_TOKEN" };

async function sh(cmd: string, env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["bash", "-c", `source ${HERE}/lib.sh; ${cmd}`], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { code, out: o + e };
}

interface Case {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

async function runCli(name: string, form: Form, args: string[], extraEnv: Record<string, string> = {}, timeoutMs = Number(process.env.CLI_TIMEOUT_MS ?? 150000)): Promise<{ code: number; out: string; err: string; ms: number }> {
  const env = [
    "PATH=/usr/local/bin:/usr/bin:/bin",
    "HOME=/home/agent",
    "CLAUDE_CONFIG_DIR=/home/agent/.claude",
    "ANTHROPIC_BASE_URL=http://127.0.0.1:3129",
    "HTTPS_PROXY=http://127.0.0.1:3128",
    "HTTP_PROXY=http://127.0.0.1:3128",
    "NO_PROXY=127.0.0.1,localhost",
    "DISABLE_AUTOUPDATER=1",
    `${CRED_VAR[form]}=${PLACEHOLDER[form]}`,
    ...Object.entries(extraEnv).map(([k, v]) => `${k}=${v}`),
    ...(process.env.EXTRA_ENV ?? "").split(" ").filter(Boolean),
  ];
  const argv = ["runsc", "--root", RS, "exec", "--user", "1000:1000", "--cwd", "/work", name, "/usr/bin/env", "-i", ...env, "claude", ...args];
  const t0 = Date.now();
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => p.kill(9), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { code, out, err, ms: Date.now() - t0 };
}

function parseResult(out: string): { result?: string; is_error?: boolean; session_id?: string; num_turns?: number } {
  try {
    return JSON.parse(out.trim().split("\n").pop() ?? "{}");
  } catch {
    return {};
  }
}

function grepTree(dir: string, needles: string[]): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    let ents: string[] = [];
    try {
      ents = readdirSync(d);
    } catch {
      return;
    }
    for (const e of ents) {
      const p = join(d, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && st.size < 64 * 1024 * 1024) {
        let b: string;
        try {
          b = readFileSync(p, "latin1");
        } catch {
          continue;
        }
        for (const n of needles) if (b.includes(n)) hits.push(`${p} contains ${n.slice(0, 12)}...`);
      }
    }
  };
  walk(dir);
  return hits;
}

const all: Record<string, unknown> = { label: LABEL, started: new Date().toISOString() };

for (const form of FORMS) {
  const W = `${SPIKE}/w3-${form}`;
  rmSync(W, { recursive: true, force: true });
  for (const d of ["home", "ws", "run", "ov"]) mkdirSync(`${W}/${d}`, { recursive: true });
  await sh(`chown 1000:1000 ${W}/home ${W}/ws`);
  const real = `REALCRED-${form}-${crypto.randomUUID()}`;
  const real2 = `REALCRED2-${form}-${crypto.randomUUID()}`;
  let cur = real;
  const upstream = startFakeUpstream(form, real, PLACEHOLDER[form]);
  const proxy = startProviderProxy(`${W}/run/llm.sock`, upstream.url, form, () => cur);
  const egress = startEgressProxy(`${W}/run/egress.sock`);
  const name = `p3${form.toLowerCase()}`;
  await sh(`runsc --root ${RS} delete -force ${name} 2>/dev/null; true`);
  const mk = await sh(`ROOTFS=${ROOTFS} BOX_INIT=1 mkspec ${name} ${W}/home ${W}/ws ${W}/run && runsc --root ${RS} --platform systrap --network none --host-uds open --overlay2 "root:dir=${W}/ov,size=2g" run --detach --bundle ${SPIKE}/specs/${name} ${name} </dev/null >${W}/run.log 2>&1`);
  const cases: Case[] = [];
  const rec = (c: Case) => {
    cases.push(c);
    console.log(`RESULT form-${form}/${c.name} | ${c.ok ? "PASS" : "FAIL"} | ${c.ms} ms | ${c.detail.replace(/\n/g, " ").slice(0, 300)}`);
  };
  if (mk.code !== 0) {
    rec({ name: "sandbox-start", ok: false, detail: mk.out.slice(0, 300), ms: 0 });
    all[`form${form}`] = { cases };
    continue;
  }
  await Bun.sleep(800);

  // 1. streaming plain turn
  let r = await runCli(name, form, ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--dangerously-skip-permissions", "hello STREAMCASE"]);
  const lines = r.out.split("\n").filter(Boolean);
  const partial = lines.filter((l) => l.includes('"stream_event"')).length;
  const res1 = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((j) => j && j.type === "result").pop();
  rec({ name: "stream", ok: !!res1 && !res1.is_error && partial > 0, detail: `exit=${r.code} stream_events=${partial} result=${JSON.stringify(res1?.result)} err=${r.err.slice(0, 160)}`, ms: r.ms });

  // 2. tool loop (three Bash calls)
  r = await runCli(name, form, ["-p", "--output-format", "json", "--dangerously-skip-permissions", "TOOLLOOP please"]);
  let j = parseResult(r.out);
  const toolSid = j.session_id;
  rec({ name: "tool-loop", ok: !j.is_error && j.result === "loop done" && (j.num_turns ?? 0) >= 4, detail: `exit=${r.code} result=${JSON.stringify(j.result)} turns=${j.num_turns} err=${r.err.slice(0, 160)}`, ms: r.ms });

  // 3. extended thinking block
  r = await runCli(name, form, ["-p", "--output-format", "json", "--dangerously-skip-permissions", "THINKING please"]);
  j = parseResult(r.out);
  rec({ name: "thinking", ok: !j.is_error && j.result === "thought done", detail: `exit=${r.code} result=${JSON.stringify(j.result)} err=${r.err.slice(0, 160)}`, ms: r.ms });

  // 4. subagent
  r = await runCli(name, form, ["-p", "--output-format", "json", "--dangerously-skip-permissions", "SUBAGENT please"]);
  j = parseResult(r.out);
  rec({ name: "subagent", ok: !j.is_error && j.result === "main done", detail: `exit=${r.code} result=${JSON.stringify(j.result)} turns=${j.num_turns} err=${r.err.slice(0, 160)}`, ms: r.ms });

  // 5. resume (same session id, transcript from the bind-mounted config dir)
  if (toolSid) {
    r = await runCli(name, form, ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", toolSid, "second turn, plain"]);
    j = parseResult(r.out);
    rec({ name: "resume", ok: !j.is_error && j.session_id !== undefined && typeof j.result === "string", detail: `exit=${r.code} result=${JSON.stringify(j.result)} session=${j.session_id === toolSid ? "same" : "forked:" + j.session_id} err=${r.err.slice(0, 160)}`, ms: r.ms });
    // 6. compaction
    r = await runCli(name, form, ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", toolSid, "/compact"]);
    j = parseResult(r.out);
    rec({ name: "compaction", ok: r.code === 0 && !j.is_error, detail: `exit=${r.code} out=${r.out.slice(0, 200)} err=${r.err.slice(0, 160)}`, ms: r.ms });
  } else rec({ name: "resume", ok: false, detail: "no session id from tool-loop", ms: 0 });

  // 7. token rotation without restarting the sandbox
  cur = real2;
  upstream.setCredential(real2);
  r = await runCli(name, form, ["-p", "--output-format", "json", "--dangerously-skip-permissions", "after rotation"]);
  j = parseResult(r.out);
  rec({ name: "rotation", ok: !j.is_error && j.result === "plain reply", detail: `exit=${r.code} result=${JSON.stringify(j.result)} err=${r.err.slice(0, 160)}`, ms: r.ms });

  // 8. leak scan: the real credentials must be nowhere in the box or in what came back
  const needles = [real, real2];
  const envDump = await sh(`runsc --root ${RS} exec ${name} /bin/sh -c 'cat /proc/1/environ | tr "\\0" "\\n"; ps -eo args 2>/dev/null; env' 2>&1`);
  const procArgsHit = needles.some((n) => envDump.out.includes(n));
  const fileHits = [...grepTree(`${W}/home`, needles), ...grepTree(`${W}/ws`, needles), ...grepTree(`${W}/run`, needles), ...grepTree(`${W}/ov`, needles)];
  const outputsHit = cases.some((c) => needles.some((n) => c.detail.includes(n)));
  const leakFree = !procArgsHit && fileHits.length === 0 && !outputsHit;
  const placeholderToUpstream = upstream.seen.filter((s) => s.placeholderInHeaders).length;
  rec({ name: "no-real-credential-in-box", ok: leakFree, detail: `env/args hit=${procArgsHit} file hits=${fileHits.length} ${fileHits.slice(0, 2).join("; ")} output hit=${outputsHit}`, ms: 0 });
  rec({ name: "placeholder-never-reaches-upstream", ok: placeholderToUpstream === 0, detail: `upstream saw ${upstream.seen.length} requests, ${placeholderToUpstream} carried the placeholder`, ms: 0 });
  const inCred = [...new Set(proxy.stats.requests.map((q) => q.credHeaderIn))];
  const bad401 = upstream.seen.filter((s) => !s.credOk && s.path.includes("/v1/messages")).length;

  // 9. egress with an empty allowlist
  const egressLines = egress.log.lines;
  const upstreamPaths = [...new Set(upstream.seen.map((s) => `${s.method} ${s.path.split("?")[0]}`))];
  const proxyPaths = [...new Set(proxy.stats.requests.map((q) => `${q.method} ${q.path.split("?")[0]}`))];
  console.log(`INFO form-${form}: inbound credential header seen by the provider proxy: ${inCred.join(",")}; upstream 401s=${bad401}; redirects refused=${proxy.stats.redirectsRefused}`);
  console.log(`INFO form-${form}: provider proxy paths: ${proxyPaths.join(" | ")}`);
  console.log(`INFO form-${form}: header names on the first upstream request: ${upstream.seen[0]?.headerNames.join(",")}`);
  console.log(`INFO form-${form}: egress proxy (empty allowlist) saw ${egressLines.length} requests: ${[...new Set(egressLines)].slice(0, 12).join(" | ")}`);

  // keep the transcript dir for the record (names only)
  const names = (await sh(`cd ${W}/home && find . -maxdepth 3 | head -30`)).out;
  all[`form${form}`] = { cases, inboundCredHeaders: inCred, upstreamPaths, proxyPaths, egressLines: [...new Set(egressLines)], upstreamFirstHeaderNames: upstream.seen[0]?.headerNames, scenarios: upstream.seen.map((s) => s.scenario).reduce((a: Record<string, number>, s) => ((a[s] = (a[s] ?? 0) + 1), a), {}), homeTree: names };

  await sh(`runsc --root ${RS} delete -force ${name} 2>/dev/null; true`);
  upstream.stop();
  proxy.stop();
  egress.stop();
}

writeFileSync(OUT, JSON.stringify(all, null, 1));
console.log(`wrote ${OUT}`);
process.exit(0);
