// scripts/e2e-ha.sh runs deploy/k8s-local/verify-ha.sh and verify-turns.sh against the e2e profile.
// Those scripts SIGKILL containers of whatever profile they select, and each reads its profile from
// its own variable. This test reads them as text and fails when one selects a cluster through a
// variable the wrapper does not set, so the wrapper has to be updated before such a change lands.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WRAPPER_SETS = ["MINIKUBE_PROFILE", "SLAUDE_LOCAL_PROFILE"];
const scripts = ["verify-ha.sh", "verify-turns.sh"];

const profileVars = (text: string): string[] => [
  ...new Set([...text.matchAll(/\$\{([A-Z_]*PROFILE[A-Z_]*)/g)].map((m) => m[1]!)),
];

for (const name of scripts) {
  const text = readFileSync(join(import.meta.dir, "../../deploy/k8s-local", name), "utf8");

  test(`${name} selects its cluster only through variables the e2e wrapper sets`, () => {
    const vars = profileVars(text);
    expect(vars.length).toBeGreaterThan(0);
    expect(vars.filter((v) => !WRAPPER_SETS.includes(v))).toEqual([]);
  });

  test(`${name} never hardcodes a context or profile on a kubectl or minikube call`, () => {
    for (const line of text.split("\n")) {
      if (/^\s*#/.test(line)) continue;
      expect(line).not.toMatch(/--context[ =](?!"?\$)/);
      expect(line).not.toMatch(/minikube -p (?!"?\$)/);
    }
  });
}

// verify-ha.sh syncs personas as code, after which the cases' seed refuses the tenant.
test("the wrapper runs the cases before the sanity scripts, and checks the scripts before either", () => {
  const wrapper = readFileSync(join(import.meta.dir, "../../scripts/e2e-ha.sh"), "utf8");
  const at = (s: string) => {
    const i = wrapper.indexOf(s);
    expect(i).toBeGreaterThan(-1);
    return i;
  };
  const check = at('sanity_env_ok || die "sanity scripts not run"');
  const cases = at('bun test "${files[@]}" --timeout 300000');
  const sanity = at('"${SANITY_SCRIPTS[0]}" || status=$?');
  expect(check).toBeLessThan(cases);
  expect(cases).toBeLessThan(sanity);
  expect(wrapper.indexOf('"${SANITY_SCRIPTS[0]}"', sanity + 1)).toBe(-1);
});

// The wrapper's helper functions, run as the wrapper defines them (extracted from its text).
function runWrapperFunction(name: string, args: string[], env: Record<string, string> = {}) {
  const wrapper = readFileSync(join(import.meta.dir, "../../scripts/e2e-ha.sh"), "utf8");
  const body = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m").exec(wrapper)?.[0];
  expect(body).toBeDefined();
  const r = Bun.spawnSync(["/bin/bash", "-c", `${body}\n${name} "$@"`, "wrapper", ...args], {
    env: { PATH: process.env.PATH!, ...env },
  });
  return { code: r.exitCode, out: r.stdout.toString() };
}

describe("the wrapper's failure hints", () => {
  let tmp = "";
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "e2e-ha-hints-"));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const log = (name: string, text: string) => {
    const f = join(tmp, name);
    writeFileSync(f, text);
    return f;
  };
  const ESC = "\u001b";

  test("a seed that cannot import an export from the image prints the E2E_FORCE_UP hint", () => {
    // Bun's message, colours included, inside the driver's "persona seed failed" error.
    const f = log("export.log", `error: persona seed failed (exit 1): ${ESC}[31mSyntaxError${ESC}[0m: ${ESC}[1mExport named 'writeSoulCacheEntry' not found in module '/app/src/soul/extract.ts'.${ESC}[0m\n`);
    const r = runWrapperFunction("stale_image_hint", [f]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("E2E_FORCE_UP=1");
  });

  test("a seed that cannot find an image module prints the hint too", () => {
    const f = log("module.log", `${ESC}[31merror${ESC}[0m: ${ESC}[1mCannot find module '/app/src/db/personas.ts' from '/tmp/seed-persona.ts'${ESC}[0m\n`);
    expect(runWrapperFunction("stale_image_hint", [f]).out).toContain("E2E_FORCE_UP=1");
  });

  test("other failures, a missing log, or an import error outside /app/src print nothing", () => {
    for (const f of [
      log("other.log", "error: no persona reply within 120000ms\n"),
      log("local.log", "Export named 'x' not found in module '/home/dev/slaude/src/soul/extract.ts'.\n"),
      join(tmp, "missing.log"),
    ]) {
      const r = runWrapperFunction("stale_image_hint", [f]);
      expect(r.code).toBe(0);
      expect(r.out).toBe("");
    }
  });

  test("a sanity failure after green cases is logged and appended to the job summary when there is one", () => {
    const summary = join(tmp, "summary.md");
    writeFileSync(summary, "earlier line\n");
    const r = runWrapperFunction("sanity_failed_summary", ["3"], { GITHUB_STEP_SUMMARY: summary });
    expect(r.out).toContain("the cases passed; the sanity checks failed (exit 3)");
    expect(readFileSync(summary, "utf8")).toBe("earlier line\nHA e2e: the cases passed; the cluster sanity scripts failed (exit 3)\n");
    const local = runWrapperFunction("sanity_failed_summary", ["3"]);
    expect(local.code).toBe(0);
    expect(local.out).toContain("(exit 3)");
  });
});

test("the wrapper sets both variables before the sanity scripts", () => {
  const wrapper = readFileSync(join(import.meta.dir, "../../scripts/e2e-ha.sh"), "utf8");
  expect(wrapper).toContain('export MINIKUBE_PROFILE="$PROFILE" SLAUDE_LOCAL_PROFILE="$PROFILE"');
  for (const v of WRAPPER_SETS) expect(wrapper).toContain(v);
});
