// Validate the agent.yaml files under $SLAUDE_HOME: the default persona's and each named persona's.
// Usage: bun src/cli/validate.ts
// Exit code: 0 = ok, 1 = missing required fields or a persona with no agent.yaml, 2 = a file that does not compile.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/home";
import { readFileAgent } from "../persona/file-agent";
import { soulOnlyPersonas } from "../persona/disk-check";
import { validateSoul } from "../soul/validate";

function main() {
  let status = 0;
  const targets: Array<{ name: string; dir: string }> = [{ name: "default", dir: paths.home }];
  if (existsSync(paths.personas)) {
    for (const n of readdirSync(paths.personas).sort()) {
      const dir = join(paths.personas, n);
      try {
        if (statSync(dir).isDirectory()) targets.push({ name: n, dir });
      } catch { /* skipped */ }
    }
  }
  for (const name of soulOnlyPersonas()) {
    console.error(`[validate] ${name}: has a SOUL.md and no agent.yaml; convert it with: bun run personas migrate ${name}`);
    status = 1;
  }
  let found = 0;
  for (const t of targets) {
    let agent;
    try {
      agent = readFileAgent(t.dir, t.name);
    } catch (e) {
      console.error(`[validate] ${t.name}: ${(e as Error).message}`);
      status = 2;
      continue;
    }
    if (!agent) continue;
    found++;
    for (const w of agent.warnings) console.warn(`[validate] ${t.name}: warning: ${w}`);
    const r = validateSoul(agent.soulJson, agent.soulMd);
    if (r.missing.length) {
      console.error(`[validate] ${t.name}: missing required fields:`);
      for (const m of r.missing) console.error(`  - ${m}`);
      status = Math.max(status, 1);
    }
    for (const w of r.warnings) console.warn(`[validate] ${t.name}: ${w}`);
    if (r.ok) console.log(`[validate] ${t.name}: ok`);
  }
  if (found === 0 && status === 0) {
    console.error("[validate] no agent.yaml found under $SLAUDE_HOME");
    status = 1;
  }
  process.exit(status);
}

main();
