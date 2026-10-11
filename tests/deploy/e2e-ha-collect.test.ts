/**
 * scripts/e2e-ha.sh's diagnostics collector, run as the script defines it (extracted from its text)
 * against a stubbed kubectl. Its port-forward wait used to end in silence after ten seconds and
 * carry on with empty captures; it must now say so, keep kubectl's own error, and fail.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../../", import.meta.url).pathname;
const wrapper = readFileSync(join(root, "scripts/e2e-ha.sh"), "utf8");
let dir = "";

const fn = (name: string) => {
  const body = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m").exec(wrapper)?.[0];
  expect(body, `${name} in scripts/e2e-ha.sh`).toBeDefined();
  return body!;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "e2e-ha-collect-"));
  writeFileSync(
    join(dir, "kubectl"),
    `#!/usr/bin/env bash
case "$*" in
  *port-forward*) echo "error: unable to listen on any of the requested ports (stub)" >&2; exit 1 ;;
esac
exit 0
`,
  );
  chmodSync(join(dir, "kubectl"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function bash(script: string, env: Record<string, string> = {}) {
  const r = Bun.spawnSync(["bash", "-c", script], {
    env: { PATH: `${dir}:${process.env.PATH}`, TMPDIR: tmpdir(), E2E_PF_TRIES: "3", ...env },
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const lib = join(root, "deploy/k8s-local/lib.sh");

test("collect_artifacts fails loudly when its port-forwards never answer, and keeps kubectl's error", () => {
  const out = join(dir, "artifacts");
  const r = bash(
    `ROOT="${root}"; PROFILE=slaude-e2e; NS=slaude-scale; ARTIFACTS="${out}"
     . "${lib}"
     ${fn("k")}
     ${fn("free_port")}
     ${fn("safe_artifacts_dir")}
     ${fn("collect_artifacts")}
     collect_artifacts`,
  );
  expect(r.code).toBe(1);
  expect(r.err).toContain("did not answer");
  expect(r.err).toContain("were NOT collected");
  // kubectl's own words are shown, not discarded
  expect(r.err).toContain("unable to listen on any of the requested ports");
  expect(existsSync(join(out, "portforward-mock-llm.err"))).toBe(true);
  expect(readFileSync(join(out, "portforward-mock-llm.err"), "utf8")).toContain("unable to listen");
  // and no empty "capture" was written in its place
  expect(existsSync(join(out, "mock-journal.json"))).toBe(false);
}, 30_000);

test("free_port never returns a port something is listening on", async () => {
  // occupy most of a 2-port window; the third value must be the free one
  const taken = await new Promise<{ port: number; close: () => void }>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => resolve({ port: (s.address() as { port: number }).port, close: () => s.close() }));
  });
  try {
    for (let i = 0; i < 5; i++) {
      const r = bash(`. "${lib}"; ${fn("free_port")}; free_port ${taken.port} 2`);
      expect(r.code).toBe(0);
      expect(Number(r.out.trim())).toBe(taken.port + 1);
    }
  } finally {
    taken.close();
  }
});
