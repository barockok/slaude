// Memory places from the command line. Runs where the deployment's database and brain are reachable
// (the gateway or mono host), never on a node.
//
//   slaude memory-places move [--apply] [--persona <name>] [--json]
//
// The move job (release rc.47): finds, in the persona's own slice (`agent-<id>`), the pages that belong to one
// place (a channel's checklist, a thread's conversation page and summary, a commitment with a thread), copies
// them into that place, and lists everything else as a review list. A dry run (the default) prints counts and
// slugs, never page text, and writes nothing. --apply copies; it never deletes the originals in this release and
// never overwrites a page the place already has, so it is safe to rerun. Run it after SLAUDE_MEMORY_BOUNDARIES=on
// has been serving for a while, with no other slaude process holding a local brain open: until then the dual history read keeps old threads readable without it.
import { parseArgs } from "node:util";
import { backgroundAgentId } from "../background/skill-check";
import { db } from "../db/schema";
import { brainCall, closeBrain } from "../knowledge/brain";
import { localMemoryBrowser } from "../knowledge/memory-browse";
import * as Sessions from "../db/sessions";
import { applyMove, formatMove, planMove, type MoveDeps } from "../memory/place-move";
import { bindPlace } from "../memory/place-binding";
import { createPlaceResolver } from "../memory/place";

const USAGE = "usage: slaude memory-places move [--apply] [--persona <name>] [--json]";
const PAGE = 200;

/** The production wiring of the move job: the real brain, database, sessions and place resolver. */
export async function defaultMoveDeps(persona: string): Promise<MoveDeps> {
  const agentId = await backgroundAgentId(persona);
  const browser = localMemoryBrowser();
  const resolve = createPlaceResolver();
  return {
    agentId,
    personaId: persona !== "default" ? persona : null,
    call: brainCall,
    async listPages(source) {
      const out: Array<{ slug: string; type: string }> = [];
      for (let offset = 0; ; offset += PAGE) {
        const rows = await browser.pages(source, { offset, limit: PAGE });
        out.push(...rows.map((r) => ({ slug: r.slug, type: r.type })));
        if (rows.length < PAGE) return out;
      }
    },
    async channels() {
      const rows = await db.query<{ slack_team_id: string | null; slack_channel_id: string | null }>("SELECT DISTINCT slack_team_id, slack_channel_id FROM sessions WHERE slack_team_id IS NOT NULL AND slack_channel_id IS NOT NULL");
      return rows.map((r) => ({ teamId: r.slack_team_id!, channel: r.slack_channel_id! }));
    },
    async session(id) {
      const s = await Sessions.findById(id);
      return s ? { teamId: s.slack_team_id ?? null, channel: s.slack_channel_id ?? null, threadTs: s.slack_thread_ts ?? null } : null;
    },
    place: resolve,
    bind: (p) => bindPlace(agentId, p),
  };
}

export async function main(argv: string[], deps: { move?: MoveDeps; out?: (s: string) => void } = {}): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: { apply: { type: "boolean" }; persona: { type: "string" }; json: { type: "boolean" } }; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options: { apply: { type: "boolean" }, persona: { type: "string" }, json: { type: "boolean" } }, allowPositionals: true });
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return 2;
  }
  const [cmd, ...extra] = parsed.positionals;
  if (cmd !== "move" || extra.length) {
    console.error(USAGE);
    return 2;
  }
  if ((process.env.SLAUDE_ROLE ?? "").trim().toLowerCase() === "node") {
    console.error("memory-places move runs on the gateway or mono host (a node has no database)");
    return 2;
  }
  const out = deps.out ?? ((s: string) => console.log(s));
  const apply = !!parsed.values.apply;
  try {
    const d = deps.move ?? (await defaultMoveDeps(parsed.values.persona?.trim() || "default"));
    const plan = await planMove(d);
    const result = apply ? await applyMove(d, plan) : undefined;
    out(parsed.values.json ? JSON.stringify({ apply, plan: { ...plan, items: plan.items.map((i) => ({ slug: i.slug, kind: i.kind, status: i.status, place: i.place.boundaryId })) }, ...(result ? { result } : {}) }, null, 2) : formatMove(plan, { apply, ...(result ? { result } : {}) }));
    return result && result.failed.length > 0 ? 1 : 0;
  } catch (e) {
    console.error(`memory-places move failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    if (!deps.move) await closeBrain().catch(() => {});
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
