/**
 * up.sh never acts on whatever kubectl context the shell happens to have: every
 * kubectl call names the profile's context, and the run stops before applying
 * anything when that context is missing or points at another cluster. Run
 * against stub minikube and kubectl in a temporary copy of the overlay.
 */
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(30000);
const root = join(import.meta.dir, "../..");
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "up-context-"));
  cpSync(join(root, "deploy/k8s-local"), join(dir, "deploy/k8s-local"), { recursive: true });
  writeFileSync(
    join(dir, "minikube"),
    `#!/usr/bin/env bash
echo "minikube $*" >>"${dir}/calls.log"
case "$*" in
  *status*) echo Running ;;
esac
exit 0
`,
  );
  writeFileSync(
    join(dir, "kubectl"),
    `#!/usr/bin/env bash
echo "kubectl $*" >>"${dir}/calls.log"
case "$*" in
  *"config get-contexts"*) printf '%s\\n' \${STUB_CONTEXTS:-other} ;;
  *"config view"*) printf '%s' "\${STUB_CLUSTER:-}" ;;
esac
exit 0
`,
  );
  chmodSync(join(dir, "minikube"), 0o755);
  chmodSync(join(dir, "kubectl"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function up(env: Record<string, string> = {}) {
  const r = Bun.spawnSync(["bash", join(dir, "deploy/k8s-local/up.sh")], {
    env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, SLAUDE_LOCAL_PROFILE: "slaude-local", ...env },
    stdin: "ignore",
    timeout: 25000,
  });
  return { code: r.exitCode, err: r.stderr.toString(), calls: existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8") : "" };
}

test("refuses to apply anything when the profile's context does not exist", () => {
  const r = up({ STUB_CONTEXTS: "some-other-cluster" });
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("no context named 'slaude-local'");
  expect(r.calls).not.toMatch(/ apply | rollout |use-context/);
  // Nothing was generated either.
  expect(existsSync(join(dir, "deploy/k8s-local/secrets.env"))).toBe(false);
});

test("refuses when a context of that name points at another cluster", () => {
  const r = up({ STUB_CONTEXTS: "slaude-local", STUB_CLUSTER: "production-cluster" });
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("does not point at minikube's cluster");
  expect(r.calls).not.toMatch(/ apply | rollout /);
});

// up.sh no longer switches the current context, so no script may rely on it.
const SCRIPTS = ["up.sh", "lib.sh", "panel.sh", "forward.sh", "vault.sh", "personas.sh", "verify-ha.sh", "verify-turns.sh", "mock-mcp/mock-mcp.sh"].map(
  (f) => `deploy/k8s-local/${f}`,
);

test("every kubectl call in the local scripts that reaches a cluster names the profile's context", () => {
  for (const f of SCRIPTS) {
    for (const line of readFileSync(join(root, f), "utf8").split("\n")) {
      if (/^\s*#/.test(line) || !/(^|[\s|(])kubectl\s/.test(line)) continue;
      // Not cluster calls: a local build, reading the kubeconfig, the prerequisite loop, message text.
      const rest = line.replace(/\s#\s.*$/, "").replace(/kubectl kustomize /, "").replace(/kubectl config (get-contexts|view) /g, "");
      if (/for bin in|die "|_say "|"kubectl has no context/.test(line)) continue;
      for (const m of rest.matchAll(/kubectl\s+(\S+)/g)) expect(`${f}: ${m[0]}`).toContain('--context');
    }
  }
});
