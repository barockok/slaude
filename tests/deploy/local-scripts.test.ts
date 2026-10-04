/**
 * vault.sh and personas.sh against a stubbed kubectl: nothing touches a cluster.
 * The stub records every command line and everything sent on stdin, so the
 * tests can prove that secret values travel on stdin only, never in a command
 * line (where `ps` and shell history would see them).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
let dir = "";
let local = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "local-scripts-"));
  // A copy of the overlay, so generated files land in the temp tree.
  cpSync(join(root, "deploy/k8s-local"), join(dir, "k8s-local"), { recursive: true });
  local = join(dir, "k8s-local");
  writeFileSync(join(local, "secrets.env"), "SLAUDE_VAULT_TOKEN=gw-token-value-1234\n");
  writeFileSync(join(local, "provider.env"), "ANTHROPIC_API_KEY=provider-secret-value\n");
  // <case>.out / <case>.rc pick the answer; every call and its stdin are logged.
  writeFileSync(
    join(dir, "kubectl"),
    `#!/usr/bin/env bash
echo "$*" >>"${dir}/calls.log"
if [[ ! -t 0 ]]; then { cat; echo; echo "--- end ($*)"; } >>"${dir}/stdin.log"; fi
pick() { [[ -f "${dir}/$1.out" ]] && cat "${dir}/$1.out"; [[ -f "${dir}/$1.rc" ]] && exit "$(cat "${dir}/$1.rc")"; exit 0; }
case "$*" in
  *"get pod"*) echo "pod/slaude-gateway-abc" ;;
  *"auth/token/lookup"*) pick lookup ;;
  *"kv metadata get"*) pick metadata ;;
  *"bun /tmp/probe/personas.ts"*) pick sync ;;
  *"[ -e "*) pick kbexists ;;
esac
exit 0
`,
  );
  chmodSync(join(dir, "kubectl"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const put = (name: string, out: string, rc = 0) => {
  writeFileSync(join(dir, `${name}.out`), out);
  writeFileSync(join(dir, `${name}.rc`), String(rc));
};
const log = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
function run(script: string, args: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync(["bash", join(local, script), ...args], {
    env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, SLAUDE_LOCAL_PROFILE: "prof", ...env },
    stdin: "ignore",
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

test("vault.sh seed: the policy, a token with the gateway's id, a secret per persona; values on stdin only", () => {
  put("lookup", "", 2); // no token yet
  put("metadata", "", 2); // no secrets yet
  const r = run("vault.sh", ["seed"]);
  expect(r.code).toBe(0);
  const calls = log("calls.log");
  const stdin = log("stdin.log");
  expect(calls).toContain("policy write slaude-personas -");
  expect(calls).toContain("auth/token/create-orphan -");
  for (const p of ["default", "alpha", "beta", "verifier"]) expect(calls).toContain(`kv put secret/slaude/personas/${p} -`);
  // Values travel on stdin, never in a command line, and are never printed.
  for (const secret of ["gw-token-value-1234", "provider-secret-value"]) {
    expect(calls).not.toContain(secret);
    expect(stdin).toContain(secret);
    expect(r.out + r.err).not.toContain(secret);
  }
  // The root token is only ever named, inside the pod's shell.
  expect(calls).toContain("$VAULT_DEV_ROOT_TOKEN_ID");
});

test("vault.sh seed keeps an existing token and a secret already seeded from this provider.env", () => {
  put("lookup", "{}", 0);
  // The seed hash vault.sh would write for this provider.env, read back as the stored one.
  const want = Bun.spawnSync(["bash", "-c", `source "${local}/lib.sh"; vault_secret_json "${local}/provider.env" alpha | shasum -a 256 | cut -c1-16`])
    .stdout.toString()
    .trim();
  put("metadata", JSON.stringify({ data: { current_version: 3, custom_metadata: { seed: want } } }));
  const r = run("vault.sh", ["seed"]);
  expect(r.code).toBe(0);
  const calls = log("calls.log");
  expect(calls).not.toContain("create-orphan");
  // alpha matches; the others (a different placeholder-free value, the same here) too, since
  // provider.env has a key and every persona's secret is that key.
  expect(calls).not.toContain("kv put");
  expect(r.out).toContain("secret/slaude/personas/alpha up to date");
});

test("vault.sh rotate reads the new value from stdin and prints a version and hash, never the value", () => {
  put("metadata", JSON.stringify({ data: { current_version: 4, custom_metadata: {} } }));
  const r = Bun.spawnSync(["bash", join(local, "vault.sh"), "rotate", "alpha"], {
    env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, SLAUDE_LOCAL_PROFILE: "prof" },
    stdin: new TextEncoder().encode("new-secret-value\n"),
  });
  expect(r.exitCode).toBe(0);
  const out = r.stdout.toString();
  expect(out).toMatch(/^rotated alpha field=api_key version=4 sha=[0-9a-f]{12}$/m);
  expect(out).not.toContain("new-secret-value");
  expect(log("calls.log")).toContain("kv patch secret/slaude/personas/alpha -");
  expect(log("calls.log")).not.toContain("new-secret-value");
  expect(log("stdin.log")).toContain('{"api_key": "new-secret-value"}');
});

test("vault.sh rotate refuses a name that is not a persona", () => {
  expect(run("vault.sh", ["rotate", "../x"]).code).not.toBe(0);
});

test("personas.sh sync sends the payload on stdin to the in-pod script and passes its flags", () => {
  put("sync", JSON.stringify({ status: 200, warnings: [], souls: { beta: "abc" } }));
  const r = run("personas.sh", ["sync", "--relabel", "beta=default", "--revision", "r-1"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out.trim()).status).toBe(200);
  const calls = log("calls.log");
  expect(calls).toContain("bun /tmp/probe/personas.ts --revision r-1");
  const sent = log("stdin.log");
  expect(sent).toContain('"runsOn": "default"');
  expect(sent).toContain("PERSONA_BETA_MOCKMCP_TOKEN");
});

test("personas.sh sync exits non-zero on a refused sync, and 0 with --any-status", () => {
  put("sync", JSON.stringify({ status: 401, warnings: [], souls: {} }));
  expect(run("personas.sh", ["sync"]).code).not.toBe(0);
  expect(run("personas.sh", ["sync", "--any-status", "--token-var", "SLAUDE_NODE_LEGACY_TOKEN"]).code).toBe(0);
});

test("personas.sh kb creates only the missing knowledge bases and reports how many", () => {
  put("kbexists", "", 1);
  const r = run("personas.sh", ["kb"]);
  expect(r.code).toBe(0);
  expect(r.out.trim()).toBe("2");
  expect(log("stdin.log")).toContain("# Local finance notes");
  put("kbexists", "", 0);
  expect(run("personas.sh", ["kb"]).out.trim()).toBe("0");
});
