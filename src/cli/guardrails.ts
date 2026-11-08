// Owner guardrails from host files. Runs where the deployment's database is
// reachable (the gateway or mono host), never on a node.
//
//   slaude guardrails import <dir> [--prune] [--dry-run] [--repair]
//
// --repair: the stored set failed its integrity check (sessions refuse to
// start) and you, the owner, have checked it. Imports <dir> and re-signs every
// stored guardrail as it is, at a version above any seen. Audited
// (guardrail.repaired).
//
// <dir> holds <slug>/GUARDRAIL.md folders (or is a deploy repo with a
// guardrails/ folder). A running server picks the change up within its poll
// (about 10 seconds) and reloads warm sessions after their turn.
import { parseArgs } from "node:util";
import { userInfo } from "node:os";
import { flushAudits } from "../audit/emit";
import { formatImportReport, importGuardrails } from "../guardrails/import";

const USAGE = "usage: slaude guardrails import <dir> [--prune] [--dry-run] [--repair]";

export async function main(argv: string[]): Promise<number> {
  let parsed: { values: { prune?: boolean; "dry-run"?: boolean; repair?: boolean }; positionals: string[] };
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { prune: { type: "boolean" }, "dry-run": { type: "boolean" }, repair: { type: "boolean" } } });
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return 2;
  }
  const [cmd, dir, ...extra] = parsed.positionals;
  if (cmd !== "import" || !dir || extra.length) {
    console.error(USAGE);
    return 2;
  }
  if ((process.env.SLAUDE_ROLE ?? "").trim().toLowerCase() === "node") {
    console.error("guardrails import runs on the gateway or mono host (a node has no database)");
    return 2;
  }
  let who = "unknown";
  try {
    who = userInfo().username;
  } catch {
    /* no passwd entry */
  }
  try {
    const r = await importGuardrails(dir, { by: `cli:${who}`, prune: !!parsed.values.prune, dryRun: !!parsed.values["dry-run"], repair: !!parsed.values.repair });
    console.log(formatImportReport(r));
  } catch (e) {
    console.error(`guardrails import failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    await flushAudits({ timeoutMs: 5000 });
  }
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
