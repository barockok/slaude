// src/cli/brain-export.ts
import { parseArgs } from "node:util";
import { exportBrain } from "../brain-migrate/export";

const USAGE = "usage: brain-export --home <brain-dir> --out <bundle-dir> [--include <source>...] [--exclude <source>...]";

let values: ReturnType<typeof parse>["values"];
function parse() {
  return parseArgs({
    options: { home: { type: "string" }, out: { type: "string" }, include: { type: "string", multiple: true }, exclude: { type: "string", multiple: true } },
  });
}
try {
  values = parse().values;
} catch (e) {
  console.error(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
  process.exit(2);
}
if (!values.home || !values.out) {
  console.error(USAGE);
  process.exit(2);
}
try {
  const { manifest } = await exportBrain({ home: values.home, out: values.out, include: values.include, exclude: values.exclude });
  console.log(`bundle written to ${values.out}`);
  console.log("source inventory (agent-like sources are remapped on import):");
  for (const s of manifest.sources) console.log(`  ${s.id.padEnd(34)} pages=${s.pages} chunks=${s.chunks} embedded=${s.embedded}`);
  if (manifest.excluded.length) console.log(`excluded: ${manifest.excluded.join(", ")}`);
} catch (e) {
  console.error(`export failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
