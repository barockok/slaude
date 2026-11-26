/**
 * The boxed variant of scripts/e2e-ha.sh (E2E_BOX), as the script defines it:
 * its two functions are extracted from the script's text and run against a
 * stubbed kubectl, and the whole script is run in dry-run mode against stubbed
 * tools. Nothing here touches a cluster, and the variant itself has never been
 * run on one.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../../", import.meta.url).pathname;
const wrapper = readFileSync(join(root, "scripts/e2e-ha.sh"), "utf8");
const sizing = Object.fromEntries(
  readFileSync(join(root, "deploy/k8s-local/sizing.env"), "utf8")
    .split("\n")
    .map((l) => /^([A-Z_]+)=(\d+)$/.exec(l))
    .filter(Boolean)
    .map((m) => [m![1], Number(m![2])]),
) as Record<string, number>;
let dir = "";

const fn = (name: string) => {
  const body = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m").exec(wrapper)?.[0];
  expect(body, `${name} in scripts/e2e-ha.sh`).toBeDefined();
  return body!;
};
const stub = (name: string, body: string) => {
  writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "e2e-ha-box-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function bash(script: string, env: Record<string, string> = {}) {
  const r = Bun.spawnSync(["bash", "-c", script], { env: { PATH: `${dir}:/usr/bin:/bin`, ...env } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
const setup = (env: Record<string, string>) =>
  bash(`ROOT="${root}"; ${fn("box_setup")}; box_setup; rc=$?; echo "rc=$rc box=\${SLAUDE_LOCAL_BOX:-} cpus=\${SLAUDE_LOCAL_CPUS:-} mem=\${SLAUDE_LOCAL_MEMORY:-} verify=\${VERIFY_BOX:-} persona=\${VERIFY_BOX_PERSONA:-}"`, env);

test("without E2E_BOX nothing is exported and nothing is said", () => {
  const r = setup({});
  expect(r.out.trim()).toBe("rc=0 box= cpus= mem= verify= persona=");
  expect(r.err).toBe("");
});

test("E2E_BOX=gvisor switches the bring-up to boxes, sizes the node up from sizing.env and hands the persona to the sanity section", () => {
  const r = setup({ E2E_BOX: "gvisor", E2E_BOX_PERSONA: "boxed" });
  const cpus = sizing.LOCAL_NODE_CPUS! + sizing.LOCAL_BOX_EXTRA_CPUS!;
  const mem = sizing.LOCAL_NODE_MEMORY_MB! + sizing.LOCAL_BOX_EXTRA_MEMORY_MB!;
  expect(r.out).toContain(`rc=0 box=gvisor cpus=${cpus} mem=${mem} verify=1 persona=boxed`);
  expect(r.out).toContain("written, never run");
});

test("a node size the operator gave is kept", () => {
  const r = setup({ E2E_BOX: "bwrap", SLAUDE_LOCAL_CPUS: "12", SLAUDE_LOCAL_MEMORY: "20000" });
  expect(r.out).toContain("rc=0 box=bwrap cpus=12 mem=20000 verify=1 persona=");
  expect(r.out).toContain("none given");
});

test("an unknown tier is refused and exports nothing", () => {
  const r = setup({ E2E_BOX: "none" });
  expect(r.out.trim()).toBe("rc=1 box= cpus= mem= verify= persona=");
  expect(r.err).toContain("E2E_BOX must be gvisor or bwrap");
});

test("cluster_boxed is true only when every node Deployment's supervisor names the wanted tier", () => {
  const run = (answers: Record<string, string>, tier: string) => {
    stub("kubectl", `case "$*" in ${Object.entries(answers).map(([dep, v]) => `*"get deploy ${dep} "*) echo "${v}" ;;`).join(" ")} esac`);
    return bash(`PROFILE=slaude-e2e; NS=slaude-scale; ${fn("k")}; ${fn("cluster_boxed")}; cluster_boxed ${tier}; echo "rc=$?"`).out.trim();
  };
  expect(run({ "slaude-node": "gvisor", "slaude-node-finance": "gvisor" }, "gvisor")).toBe("rc=0");
  expect(run({ "slaude-node": "gvisor", "slaude-node-finance": "" }, "gvisor")).toBe("rc=1");
  expect(run({ "slaude-node": "", "slaude-node-finance": "" }, "gvisor")).toBe("rc=1");
  expect(run({ "slaude-node": "gvisor", "slaude-node-finance": "gvisor" }, "bwrap")).toBe("rc=1");
});

/** The whole script in dry-run mode: minikube reports nothing running, kubectl answers `ready` for every Deployment. */
function dryRun(env: Record<string, string>, boxTier = "") {
  stub("minikube", `case "$*" in *"profile list"*) echo '{"valid":[]}' ;; esac; exit 0`);
  stub(
    "kubectl",
    `case "$*" in
  *"get deploy slaude-gateway slaude-node "*) echo "1/1 1/1 1/1 1/1 1/1 1/1 1/1 1/1 1/1 " ;;
  *"get deploy slaude-node"*boxd*) echo "${boxTier}" ;;
esac
exit 0`,
  );
  for (const t of ["curl", "jq"]) stub(t, "exit 0");
  const r = Bun.spawnSync(["bash", join(root, "scripts/e2e-ha.sh")], {
    env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, TMPDIR: tmpdir(), E2E_DRY_RUN: "1", ...env },
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

test("dry run without E2E_BOX: a Ready cluster is not brought up again and no box variable is named", () => {
  const r = dryRun({ E2E_SANITY: "1" });
  expect(r.out).toContain("cluster Ready, skipping bring-up");
  expect(r.out).not.toContain("SLAUDE_LOCAL_BOX");
  expect(r.out).not.toContain("VERIFY_BOX");
  expect(r.out).not.toContain("boxed variant");
}, 60_000);

test("dry run with E2E_BOX on a Ready cluster that has no supervisor: it would bring the stack up with boxes and run the boxed sanity section", () => {
  const r = dryRun({ E2E_BOX: "gvisor", E2E_BOX_PERSONA: "boxed", E2E_SANITY: "1" });
  expect(r.out).toContain("its node pods have no box supervisor on tier gvisor; bringing it up again");
  expect(r.out).toMatch(/dry run, would run: SLAUDE_LOCAL_PROFILE=slaude-e2e SLAUDE_LOCAL_BOX=gvisor SLAUDE_LOCAL_CPUS=\d+ SLAUDE_LOCAL_MEMORY=\d+ .*e2e\/up\.sh/);
  expect(r.out).toMatch(/dry run, would run: MINIKUBE_PROFILE=slaude-e2e SLAUDE_LOCAL_PROFILE=slaude-e2e VERIFY_BOX=1 VERIFY_BOX_PERSONA=boxed .*verify-turns\.sh/);
}, 60_000);

test("dry run with E2E_BOX on a cluster already on that tier skips the bring-up", () => {
  const r = dryRun({ E2E_BOX: "gvisor" }, "gvisor");
  expect(r.out).toContain("cluster Ready, skipping bring-up");
  expect(r.out).not.toContain("bringing it up again");
}, 60_000);

test("the script says the variant was written and never run, and that it syncs no boxed persona", () => {
  expect(wrapper).toContain("WRITTEN, NOT");
  expect(wrapper).toContain("Nothing here");
  expect(wrapper).toContain("builds or pushes a box image or syncs such a persona");
});
