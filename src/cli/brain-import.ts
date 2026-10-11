import { parseArgs } from "node:util";
import { hasProblems, runImport } from "../brain-migrate/client";

const USAGE = "usage: brain-import --gateway <url> --persona <name> [--token-env VAR] [--dry-run] [--on-conflict skip|overwrite|fail] [--map from=to ...] <bundle>";

function parse() {
  return parseArgs({
    allowPositionals: true,
    options: {
      gateway: { type: "string" }, persona: { type: "string" }, "token-env": { type: "string" },
      "dry-run": { type: "boolean" }, "on-conflict": { type: "string" }, map: { type: "string", multiple: true },
    },
  });
}
let parsed: ReturnType<typeof parse>;
try {
  parsed = parse();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  console.error(USAGE);
  process.exit(2);
}
const { values, positionals } = parsed;
const bundle = positionals[0];
const tokenEnv = values["token-env"] ?? "SLAUDE_BRAIN_IMPORT_TOKEN";
const token = process.env[tokenEnv];
if (!values.gateway || !values.persona || !bundle) {
  console.error(USAGE);
  process.exit(2);
}
if (!token) { console.error(`set ${tokenEnv} in the environment (never a flag)`); process.exit(2); }
const onConflict = values["on-conflict"];
if (onConflict !== undefined && !["skip", "overwrite", "fail"].includes(onConflict)) {
  console.error(`--on-conflict must be skip, overwrite or fail`);
  process.exit(2);
}
const map: Record<string, string> = {};
for (const m of values.map ?? []) {
  const i = m.indexOf("=");
  if (i <= 0 || i === m.length - 1) { console.error(`--map expects from=to, got '${m}'`); process.exit(2); }
  map[m.slice(0, i)] = m.slice(i + 1);
}
try {
  const s = await runImport({
    gateway: values.gateway, persona: values.persona, token, bundle,
    dryRun: !!values["dry-run"], onConflict: onConflict as "skip" | "overwrite" | "fail" | undefined,
    ...(Object.keys(map).length ? { map } : {}), log: (l) => console.log(l),
  });
  console.log(`${values["dry-run"] ? "DRY RUN " : ""}target agent slice: ${s.agentSource}`);
  for (const [k, c] of Object.entries(s.sources)) console.log(`  ${k.padEnd(34)} written=${c.written} skipped=${c.skipped} overwritten=${c.overwritten} failed=${c.failed} links=${c.linksWritten} written/${c.linksDropped} dropped/${c.linksFailed} failed no-embedding=${c.noEmbedding}`);
  if (s.failedSlugs.length) console.error(`failed pages: ${s.failedSlugs.join(", ")}`);
  const reasons = Object.entries(s.failedReasons);
  if (reasons.length) console.error(`failure reasons: ${reasons.map(([r, n]) => `${r}=${n}`).join(", ")}`);
  for (const m of s.mismatches) console.error(`MISMATCH ${m}`);
  process.exit(hasProblems(s) ? 1 : 0);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
