// scripts/e2e-ha.sh runs deploy/k8s-local/verify-ha.sh and verify-turns.sh against the e2e profile.
// Those scripts SIGKILL containers of whatever profile they select, and each reads its profile from
// its own variable. This test reads them as text and fails when one selects a cluster through a
// variable the wrapper does not set, so the wrapper has to be updated before such a change lands.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

test("the wrapper sets both variables before the sanity scripts", () => {
  const wrapper = readFileSync(join(import.meta.dir, "../../scripts/e2e-ha.sh"), "utf8");
  expect(wrapper).toContain('export MINIKUBE_PROFILE="$PROFILE" SLAUDE_LOCAL_PROFILE="$PROFILE"');
  for (const v of WRAPPER_SETS) expect(wrapper).toContain(v);
});
