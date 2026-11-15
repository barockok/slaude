// Domain records from the command line. Runs where the deployment's database
// is reachable (the gateway or mono host), never on a node.
//
//   slaude domain reconcile [--dry-run] [--json] [--demote-unproven-emails [--apply]]
//   slaude domain boundary-check [--table <name>] [--json]
//
// boundary-check is read only: it recomputes the boundary of every row that
// carries one and counts the rows that should and do not. Exit 0 when every gate
// number is 0 (no NULL boundary older than 10 minutes on an eligible channel with
// a resolvable workspace, no mismatch, no duplicate group), 1 when not, 2 on a
// usage error or a node, 3 when it could not read the database.
//
// Backfills and repairs users, bindings and boundaries from accounts, Slack
// identities, grants, sessions and audit actors. Safe to rerun. --dry-run
// reports what would be created and writes nothing. On sqlite the workspace
// comes from SLAUDE_SLACK_TEAM_ID (comma separated) when set; Postgres reads
// slack_apps.
//
// Every run reports the verified email bindings no proving login backs (the
// count per issuer, never an address). --demote-unproven-emails names that
// section on purpose; it only changes anything together with --apply, which
// sets those bindings back to observed (a login with proof raises them again).
// The gateway's boot reconcile never does this.
import { parseArgs } from "node:util";
import { flushAudits } from "../audit/emit";
import { formatReconcileReport, reconcile } from "../domain/reconcile";
import { boundaryParity, formatParity, type ParityReport } from "../domain/boundary-parity";
import { loadWorkspaces } from "../domain/boundary-backfill";
import { db as globalDb } from "../db/schema";

const USAGE = "usage: slaude domain reconcile [--dry-run] [--json] [--demote-unproven-emails [--apply]]\n       slaude domain boundary-check [--table <name>] [--json]";

export async function main(argv: string[], deps: { reconcile?: typeof reconcile; boundaryCheck?: (o: { table?: string }) => Promise<ParityReport>; out?: (s: string) => void } = {}): Promise<number> {
  let parsed: { values: { "dry-run"?: boolean; json?: boolean; "demote-unproven-emails"?: boolean; apply?: boolean; table?: string }; positionals: string[] };
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { "dry-run": { type: "boolean" }, json: { type: "boolean" }, "demote-unproven-emails": { type: "boolean" }, apply: { type: "boolean" }, table: { type: "string" } },
    });
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return 2;
  }
  const [cmd, ...extra] = parsed.positionals;
  if (cmd === "boundary-check" && !extra.length) return boundaryCheck(parsed.values, deps);
  if (cmd !== "reconcile" || extra.length) {
    console.error(USAGE);
    return 2;
  }
  const demote = !!parsed.values["demote-unproven-emails"];
  const apply = !!parsed.values.apply;
  if ((apply && !demote) || (apply && parsed.values["dry-run"])) {
    console.error(`--apply goes with --demote-unproven-emails and not with --dry-run\n${USAGE}`);
    return 2;
  }
  if ((process.env.SLAUDE_ROLE ?? "").trim().toLowerCase() === "node") {
    console.error("domain reconcile runs on the gateway or mono host (a node has no database)");
    return 2;
  }
  const out = deps.out ?? ((s: string) => console.log(s));
  const teams = (process.env.SLAUDE_SLACK_TEAM_ID ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  try {
    const r = await (deps.reconcile ?? reconcile)({
      dryRun: !!parsed.values["dry-run"],
      liveTeamIds: () => teams,
      ...(demote && apply ? { demoteUnprovenEmails: true } : {}),
    });
    out(parsed.values.json ? JSON.stringify(r, null, 2) : formatReconcileReport(r));
  } catch (e) {
    console.error(`domain reconcile failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    await flushAudits({ timeoutMs: 5000 });
  }
  return 0;
}

async function boundaryCheck(v: { json?: boolean; table?: string; "dry-run"?: boolean; apply?: boolean; "demote-unproven-emails"?: boolean }, deps: { boundaryCheck?: (o: { table?: string }) => Promise<ParityReport>; out?: (s: string) => void }): Promise<number> {
  if (v["dry-run"] || v.apply || v["demote-unproven-emails"]) {
    console.error(`boundary-check takes only --table and --json\n${USAGE}`);
    return 2;
  }
  if ((process.env.SLAUDE_ROLE ?? "").trim().toLowerCase() === "node") {
    console.error("domain boundary-check runs on the gateway or mono host (a node has no database)");
    return 2;
  }
  const out = deps.out ?? ((s: string) => console.log(s));
  const teams = (process.env.SLAUDE_SLACK_TEAM_ID ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  try {
    const r = await (deps.boundaryCheck ?? (async (o) => boundaryParity(globalDb, { place: await loadWorkspaces(globalDb, () => teams), table: o.table })))({ table: v.table });
    out(v.json ? JSON.stringify(r, null, 2) : formatParity(r));
    return r.ok ? 0 : 1;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`domain boundary-check failed: ${msg}`);
    return msg.startsWith("unknown table") ? 2 : 3;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
