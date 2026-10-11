// e2e/up.sh and scripts/build-e2e-images.sh mutate whatever minikube profile they are given, so
// both must refuse a non-e2e profile before their first external command. Hermetic: PATH starts
// with stubs for every tool the scripts call, and each stub records that it ran and fails loudly,
// so a guard that came too late shows up as a stub call, never as a real cluster action.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const TOOLS = ["minikube", "kubectl", "docker", "bun", "curl"];
let stubs = "";
let marker = "";

beforeAll(() => {
  stubs = mkdtempSync(join(tmpdir(), "script-guard-stubs-"));
  marker = join(stubs, "called");
  for (const t of TOOLS) {
    const file = join(stubs, t);
    writeFileSync(file, `#!/bin/sh\necho "${t} $*" >> "${marker}"\necho "STUB ${t} MUST NOT RUN" >&2\nexit 99\n`);
    chmodSync(file, 0o755);
  }
});

afterAll(() => rmSync(stubs, { recursive: true, force: true }));

function run(script: string, profile: string) {
  rmSync(marker, { force: true });
  const p = Bun.spawnSync(["/bin/bash", join(ROOT, script)], {
    env: { PATH: `${stubs}:/usr/bin:/bin`, HOME: stubs, SLAUDE_LOCAL_PROFILE: profile },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, stderr: p.stderr.toString(), called: existsSync(marker) ? readFileSync(marker, "utf8") : "" };
}

for (const [script, prefix] of [["e2e/up.sh", "e2e-up"], ["scripts/build-e2e-images.sh", "build-e2e-images"]] as const) {
  test(`${script} refuses a non-e2e profile before calling any tool`, () => {
    for (const profile of ["slaude-local", "minikube", "e2e-slaude"]) {
      const r = run(script, profile);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(`${prefix}: profile '${profile}' does not match /^slaude-e2e/; refusing to touch it`);
      expect(r.called).toBe("");
    }
  });

  test(`${script} gets past the guard for an e2e profile (the stubs do intercept)`, () => {
    const r = run(script, "slaude-e2e-guardtest");
    expect(r.code).not.toBe(0);
    expect(r.called).not.toBe("");
    expect(r.stderr).not.toContain("refusing to touch it");
  });
}
