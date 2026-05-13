// Validate $SLAUDE_HOME/SOUL.md against the required schema.
// Usage: bun src/cli/validate.ts
// Exit code: 0 = ok, 1 = missing required fields, 2 = extraction failure.

import { loadSoulData } from "../soul/extract";
import { validateSoul } from "../soul/validate";

async function main() {
  let data;
  try {
    data = await loadSoulData();
  } catch (e: any) {
    console.error("[validate] failed to load SOUL.md:", e?.message ?? e);
    process.exit(2);
  }

  const r = validateSoul(data);
  if (r.missing.length) {
    console.error("[validate] missing required fields:");
    for (const m of r.missing) console.error(`  - ${m}`);
  }
  if (r.warnings.length) {
    console.warn("[validate] warnings:");
    for (const w of r.warnings) console.warn(`  - ${w}`);
  }
  if (r.ok) {
    console.log("[validate] ok");
    process.exit(0);
  }
  process.exit(1);
}

void main();
