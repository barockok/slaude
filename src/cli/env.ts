// Shared environments from the command line. Runs where the deployment's
// database is reachable (the gateway or mono host), never on a node.
//
//   slaude env list [--tenant <id>]
//   slaude env unbind-shared (--tenant <id> | --all-tenants) (--dry-run | --apply)
//
// `list` is read only: definition names and how many threads are bound to each
// (never a host, address, key or hash).
//
// `unbind-shared` is step zero of a rollback to rc.23: rc.23 reads a thread
// bound to a shared environment as a personal ssh row, so every such binding
// is removed first (a gateway that runs a bound thread without shared-environment
// support runs it on the SERVER, so this is done on purpose, one tenant at a time:
// --tenant <id>, or --all-tenants spelled out). --dry-run reports what would go;
// --apply removes it and cleans up each thread's remote jobs on the machine. One
// of the two is required. The definition rows stay (do not drop the 0051
// columns). Threads fall back to the server on their next turn, and are NOT told
// here (this command has no Slack connection); a warm session keeps its tools
// until it reboots, so run this, then redeploy.
import { parseArgs } from "node:util";
import { emitAudit, flushAudits } from "../audit/emit";
import { sharedBindingCounts, unbindShared } from "../remote/definitions/unbind";

const USAGE = "usage: slaude env list [--tenant <id>] | slaude env unbind-shared (--tenant <id> | --all-tenants) (--dry-run | --apply)";

export async function main(argv: string[], deps: { out?: (s: string) => void } = {}): Promise<number> {
  let parsed: { values: { "dry-run"?: boolean; apply?: boolean; tenant?: string; "all-tenants"?: boolean }; positionals: string[] };
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { "dry-run": { type: "boolean" }, apply: { type: "boolean" }, tenant: { type: "string" }, "all-tenants": { type: "boolean" } } });
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return 2;
  }
  const out = deps.out ?? ((s: string) => console.log(s));
  const [cmd, ...extra] = parsed.positionals;
  const dry = !!parsed.values["dry-run"];
  const apply = !!parsed.values.apply;
  const tenant = parsed.values.tenant;
  const allTenants = !!parsed.values["all-tenants"];
  if (extra.length || (cmd !== "list" && cmd !== "unbind-shared") || (cmd === "list" && (dry || apply || allTenants)) || (tenant !== undefined && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(tenant))) {
    console.error(USAGE);
    return 2;
  }
  if (cmd === "unbind-shared" && dry === apply) {
    console.error(`unbind-shared needs exactly one of --dry-run and --apply\n${USAGE}`);
    return 2;
  }
  if (cmd === "unbind-shared" && (tenant === undefined) === !allTenants) {
    console.error(`unbind-shared needs exactly one of --tenant <id> and --all-tenants\n${USAGE}`);
    return 2;
  }
  if ((process.env.SLAUDE_ROLE ?? "").trim().toLowerCase() === "node") {
    console.error("env commands run on the gateway or mono host (a node has no database)");
    return 2;
  }
  try {
    const counts = await sharedBindingCounts(tenant);
    const total = counts.reduce((n, c) => n + c.threads, 0);
    const lines = counts.map((c) => `  env:${c.name}${c.tenant === "default" ? "" : ` (tenant ${c.tenant})`}: ${c.threads} thread${c.threads === 1 ? "" : "s"}`);
    if (cmd === "list") {
      out(total ? `Threads bound to shared environments:\n${lines.join("\n")}` : "No thread is bound to a shared environment.");
      return 0;
    }
    if (dry) {
      out(total ? `Would unbind ${total} thread${total === 1 ? "" : "s"} from shared environments:\n${lines.join("\n")}` : "Nothing to unbind: no thread is bound to a shared environment.");
      return 0;
    }
    const done = await unbindShared(tenant);
    for (const d of done) {
      emitAudit({
        tenantId: d.tenant, persona: "default", actorKind: "system", actorId: "cli", action: "environment.unbound_shared",
        targetKind: "tenant", targetId: d.tenant, summary: `unbound ${d.threads} thread(s) from shared environments`, details: { threads: d.threads },
      });
    }
    const n = done.reduce((a, d) => a + d.threads, 0);
    out(`Unbound ${n} thread${n === 1 ? "" : "s"} from shared environments${done.length > 1 ? ` (${done.map((d) => `${d.tenant}: ${d.threads}`).join(", ")})` : ""}. They are not told here; their next turn runs on the server on a gateway without shared environments. Redeploy when ready.`);
    return 0;
  } catch (e) {
    console.error(`env command failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    await flushAudits({ timeoutMs: 5000 });
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
