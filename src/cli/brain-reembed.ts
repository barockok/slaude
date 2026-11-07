// Re-embed brain chunks whose embedding model label differs from the configured
// model. Dry run by default.
//
//   slaude brain reembed --model-mismatch                 # report only
//   slaude brain reembed --model-mismatch --apply         # re-embed
//   slaude brain reembed --model-mismatch --source <id>   # one source (repeatable)
//
// Run it where the brain engine runs with the deployment's EMBEDDING_* env (the
// gateway container, or the brain server in remote mode). With an embedded
// PGLite brain stop the gateway first: PGLite is single-writer.
import { parseArgs } from "node:util";
import { closeBrain } from "../knowledge/brain";
import { formatReembedReport, runReembedCommand } from "../knowledge/brain-reembed";

const USAGE = "usage: slaude brain reembed --model-mismatch [--apply] [--source <id>...]";
let values: { "model-mismatch"?: boolean; apply?: boolean; source?: string[] };
try {
  values = parseArgs({
    options: { "model-mismatch": { type: "boolean" }, apply: { type: "boolean" }, source: { type: "string", multiple: true } },
  }).values;
} catch (e) {
  console.error(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
  process.exit(2);
}
if (!values["model-mismatch"]) {
  console.error(USAGE);
  process.exit(2);
}
let code = 0;
try {
  const r = await runReembedCommand({ apply: !!values.apply, sourceIds: values.source, log: (m) => console.log(m) });
  console.log(formatReembedReport(r));
  if (r.errors.length) code = 1;
} catch (e) {
  console.error(`reembed failed: ${e instanceof Error ? e.message : String(e)}`);
  code = 1;
}
await closeBrain();
process.exit(code);
