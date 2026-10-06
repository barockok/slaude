/**
 * deploy/k8s-local/lib.sh against a stubbed kubectl. Nothing here touches a
 * cluster: the stub answers from files in a temp dir and records every call.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const lib = new URL("../../deploy/k8s-local/lib.sh", import.meta.url).pathname;
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "local-lib-"));
  // Behaviour is chosen by files: <name>.out is the stdout, <name>.rc the exit code (default 0).
  // Calls are appended to calls.log.
  writeFileSync(
    join(dir, "kubectl"),
    `#!/usr/bin/env bash
echo "$*" >>"${dir}/calls.log"
args="$*"
pick() { # <name>
  [[ -f "${dir}/$1.out" ]] && cat "${dir}/$1.out"
  [[ -f "${dir}/$1.rc" ]] && exit "$(cat "${dir}/$1.rc")"
  exit 0
}
case "$args" in
  *pg_isready*) pick pg_isready ;;
  *"select 1 from pg_database"*) pick exists ;;
  *"CREATE DATABASE"*) pick create ;;
  *"CREATE EXTENSION"*) pick extension ;;
  *"get hpa"*minReplicas*) pick hpa_min ;;
  *"get hpa"*"jsonpath={.spec.maxReplicas}"*) pick hpa_max ;;
  *"get hpa"*original-max-replicas*) pick hpa_saved ;;
  *"patch hpa"*) pick hpa_patch ;;
esac
exit 0
`,
  );
  chmodSync(join(dir, "kubectl"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(body: string, env: Record<string, string> = {}) {
  const r = Bun.spawnSync(
    ["bash", "-c", `source "${lib}"; die() { echo "DIE: $*" >&2; return 1; }; NS=ns PROFILE=prof; ${body}`],
    { env: { PATH: `${dir}:${process.env.PATH}`, PG_SLEEP: "0", ...env } },
  );
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
const calls = () => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8") : "");
const set = (name: string, out: string, rc = 0) => {
  writeFileSync(join(dir, `${name}.out`), out);
  writeFileSync(join(dir, `${name}.rc`), String(rc));
};

test("the readiness wait probes over TCP, not the unix socket", () => {
  const r = run("ensure_brain_database");
  expect(r.code).toBe(0);
  expect(calls()).toContain("pg_isready -h 127.0.0.1");
});

test("a Postgres that never accepts TCP fails loudly after the last attempt", () => {
  set("pg_isready", "", 2);
  const r = run("ensure_brain_database", { PG_TRIES: "3" });
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("did not accept TCP connections after 3 attempts");
  expect(calls().match(/pg_isready/g)?.length).toBe(3);
  // it never went on to create anything
  expect(calls()).not.toContain("CREATE DATABASE");
});

test("losing the CREATE DATABASE race ('already exists') counts as success", () => {
  set("exists", "");
  set("create", 'ERROR:  database "slaude_brain" already exists', 1);
  const r = run("ensure_brain_database");
  expect(r.code).toBe(0);
  expect(calls()).toContain("CREATE EXTENSION");
});

test("a database that is already there is not created again", () => {
  set("exists", "1\n");
  const r = run("ensure_brain_database");
  expect(r.code).toBe(0);
  expect(calls()).not.toContain("CREATE DATABASE");
});

test("the existence check compares output exactly: text merely containing a 1 is not 'exists'", () => {
  set("exists", "ERROR: connection 1 refused\n", 0);
  const r = run("ensure_brain_database");
  expect(r.code).toBe(0);
  expect(calls()).toContain("CREATE DATABASE");
});

test("any other CREATE DATABASE failure is retried, then reported", () => {
  set("exists", "");
  set("create", "ERROR:  the database system is shutting down", 1);
  const r = run("ensure_brain_database", { CREATE_TRIES: "3" });
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("after 3 attempts");
  expect(r.err).toContain("shutting down");
  expect(calls().match(/CREATE DATABASE/g)?.length).toBe(3);
  expect(calls()).not.toContain("CREATE EXTENSION");
});

test("resolve_local_model: the shell wins, then the dotenv file (last assignment, quotes stripped)", () => {
  expect(run("resolve_local_model", { SLAUDE_LOCAL_MODEL: "from/shell" }).out).toBe("from/shell");
  const f = join(dir, "dot.env");
  writeFileSync(f, `OTHER=1\nSLAUDE_LOCAL_MODEL=old/model\nexport SLAUDE_LOCAL_MODEL="provider/new-model"\n`);
  expect(run("resolve_local_model", { SLAUDE_LOCAL_ENV_FILE: f }).out).toBe("provider/new-model");
  expect(run("resolve_local_model", { SLAUDE_LOCAL_ENV_FILE: f, SLAUDE_LOCAL_MODEL: "from/shell" }).out).toBe("from/shell");
  // unset everywhere: nothing, and success (the file stays empty)
  writeFileSync(f, "OTHER=1\n");
  expect(run("resolve_local_model", { SLAUDE_LOCAL_ENV_FILE: f })).toMatchObject({ code: 0, out: "" });
  expect(run("resolve_local_model")).toMatchObject({ code: 0, out: "" });
  // a named file that cannot be read is an error, not "no model"
  const bad = run("resolve_local_model", { SLAUDE_LOCAL_ENV_FILE: join(dir, "missing.env") });
  expect(bad.code).toBe(1);
  expect(bad.err).toContain("not readable");
});

test("vm_size_warning stays quiet for a big enough VM and speaks for a small one", () => {
  const GB = 1024 ** 3;
  // Docker reports a little under the nominal size: 5.9 GiB for a 6 GiB VM must pass.
  expect(run(`vm_size_warning 4 ${Math.floor(5.9 * GB)} 4 6144`)).toMatchObject({ code: 0, out: "" });
  const few = run(`vm_size_warning 2 ${6 * GB} 4 6144`);
  expect(few.code).toBe(1);
  expect(few.out).toContain("2 CPU");
  expect(few.out).toContain("provisional floor is 4 CPU and 6144 MB");
  const small = run(`vm_size_warning 4 ${3 * GB} 4 6144`);
  expect(small.code).toBe(1);
  expect(small.out).toContain("3072 MB");
});

test("pin_node_hpa sets max = min and records the original; restore puts it back", () => {
  set("hpa_min", "2");
  set("hpa_max", "3");
  set("hpa_saved", "");
  const r = run("pin_node_hpa && restore_node_hpa");
  expect(r.code).toBe(0);
  const patches = calls().split("\n").filter((l) => l.includes("patch hpa"));
  expect(patches).toHaveLength(2);
  expect(patches[0]).toContain('"maxReplicas":2');
  expect(patches[0]).toContain('"slaude.dev/original-max-replicas":"3"');
  expect(patches[1]).toContain('"maxReplicas":3');
  expect(patches[1]).toContain('"slaude.dev/original-max-replicas":null');
});

test("a previous run killed before its trap cannot make the pinned value the 'original'", () => {
  set("hpa_min", "2");
  set("hpa_max", "2"); // still pinned from the dead run
  set("hpa_saved", "3"); // the annotation it left behind
  const r = run("pin_node_hpa && restore_node_hpa");
  expect(r.code).toBe(0);
  const patches = calls().split("\n").filter((l) => l.includes("patch hpa"));
  expect(patches[1]).toContain('"maxReplicas":3');
});

test("restore does nothing when nothing was pinned, and says so when it cannot restore", () => {
  expect(run("restore_node_hpa").code).toBe(0);
  expect(calls()).not.toContain("patch hpa");

  set("hpa_min", "2");
  set("hpa_max", "3");
  set("hpa_saved", "");
  // the second patch (the restore) fails
  writeFileSync(
    join(dir, "kubectl"),
    readFileSync(join(dir, "kubectl"), "utf8").replace(
      '*"patch hpa"*) pick hpa_patch ;;',
      '*"patch hpa"*) if [[ -f "' + dir + '/patched" ]]; then echo boom >&2; exit 1; fi; touch "' + dir + '/patched"; exit 0 ;;',
    ),
  );
  const r = run("pin_node_hpa; restore_node_hpa");
  expect(r.code).toBe(1);
  expect(r.out).toContain("could not restore hpa/slaude-node-cpu-fallback maxReplicas to 3");
});

test("verify-ha.sh pins the node HPA before its baseline and restores it in its EXIT trap", () => {
  const text = readFileSync(new URL("../../deploy/k8s-local/verify-ha.sh", import.meta.url).pathname, "utf8");
  expect(text).toContain('. "$HERE/lib.sh"');
  const body = /^cleanup\(\) \{[\s\S]*?^\}/m.exec(text)?.[0] ?? "";
  expect(body).toContain("restore_node_hpa");
  expect(text).toContain("trap cleanup EXIT");
  expect(text.indexOf("pin_node_hpa")).toBeLessThan(text.indexOf('expect "two node replicas ready"'));
});

test("pin_node_hpa reports an HPA it cannot read instead of pinning blind", () => {
  set("hpa_min", "", 1);
  const r = run("pin_node_hpa");
  expect(r.code).toBe(1);
  expect(r.out).toContain("could not read minReplicas/maxReplicas");
  expect(calls()).not.toContain("patch hpa");
});
