/**
 * Scripts the docs tell people to run directly must be executable in git (mode
 * 100755). Tests that run `bash script` hide a missing bit: `./script.sh` then
 * fails with "permission denied" (exit 126). Sourced files are not executed.
 */
import { expect, test } from "bun:test";

const root = new URL("../../", import.meta.url).pathname;
const run = ["up.sh", "down.sh", "panel.sh", "verify-ha.sh", "verify-turns.sh", "forward.sh", "vault.sh", "personas.sh", "mock-mcp/mock-mcp.sh"].map(
  (f) => `deploy/k8s-local/${f}`,
).concat(["scripts/e2e-ha.sh", "e2e/up.sh"]);
const sourced = ["deploy/k8s-local/lib.sh", "deploy/k8s-local/sizing.env"];

const modes = new Map<string, string>();
for (const line of Bun.spawnSync(["git", "ls-files", "-s", "deploy", "scripts", "e2e"], { cwd: root }).stdout.toString().split("\n")) {
  const m = /^(\d+) \S+ \d\t(.+)$/.exec(line);
  if (m) modes.set(m[2]!, m[1]!);
}

test("every documented-executable script is committed as 100755", () => {
  for (const f of run) expect(modes.get(f), f).toBe("100755");
});

test("sourced helper files are not executable", () => {
  for (const f of sourced) expect(modes.get(f), f).toBe("100644");
});

test("every script under deploy/k8s-local that is not sourced is executable", () => {
  for (const [f, mode] of modes) {
    if (f.startsWith("deploy/k8s-local/") && f.endsWith(".sh") && !sourced.includes(f)) expect(mode, f).toBe("100755");
  }
});
