/**
 * The move job (memory places, rc.47): copies the pages of the persona's slice (`agent-<id>`) that belong to ONE
 * place into that place, and lists the rest for review. Run by an operator with `slaude memory-places move`.
 *
 * Attributable pages:
 *   - a channel's checklist, `self/heartbeat/<channel>` (the channel's place);
 *   - a thread's conversation page `conversations/<session>` with its timeline, and its `/summary` page (the
 *     session's place, from its row);
 *   - a commitment whose `thread` names `<channel>:<ts>` (that channel's place).
 * Everything else stays and goes on the review list. A page whose channel has no single known workspace is on the
 * review list too: guessing a place would be the leak this work removes.
 *
 * It never deletes and never overwrites: a page already in the place is left as it is (same text: counted as there;
 * different text: counted as a conflict and listed). A conversation whose place already holds some of its turns
 * but fewer than the source is a conflict as well (copying would put older turns after newer ones). The originals stay
 * in this release, so rerunning is safe and the dual history read keeps working (it drops a turn the place and the
 * slice both hold). The dry run prints counts and slugs, never page text.
 */
import { readPageRecord } from "../knowledge/memory-pages";
import { getPageOrNull, type BrainOpCall } from "../knowledge/memory-trail";
import { agentSourceId, type BrainScope } from "../knowledge/scope";
import { parseThread } from "../proactive/due";
import type { PlaceInput, PlaceRef } from "./place";
import { placeBound } from "./place-binding";
import { hasPlacePrefix } from "./place-id";

export interface MoveSessionRow {
  teamId: string | null;
  channel: string | null;
  threadTs: string | null;
}

export interface MoveDeps {
  agentId: string;
  personaId: string | null;
  call: BrainOpCall;
  /** Every page of a source (slug and type), all of them. */
  listPages(source: string): Promise<Array<{ slug: string; type: string }>>;
  /** The Slack (workspace, channel) pairs the install has seen sessions in. */
  channels(): Promise<Array<{ teamId: string; channel: string }>>;
  /** A session row by id, or null. */
  session(id: string): Promise<MoveSessionRow | null>;
  /** The place of a turn's location (the resolver, not the mode-gated function). */
  place(i: PlaceInput): Promise<PlaceRef>;
  /** Bind a place to the agent in the registry (apply only). */
  bind(place: Extract<PlaceRef, { kind: "place" }>): Promise<boolean>;
}

export type MoveKind = "checklist" | "conversation" | "summary" | "commitment";
export type MoveStatus = "new" | "there" | "conflict";

export interface MoveItem {
  slug: string;
  kind: MoveKind;
  place: Extract<PlaceRef, { kind: "place" }>;
  status: MoveStatus;
}

export interface ReviewItem {
  slug: string;
  type: string;
  reason: string;
}

export interface MovePlan {
  agentSource: string;
  items: MoveItem[];
  review: ReviewItem[];
}

const HEARTBEAT = /^self\/heartbeat\/([^/]+)$/;
const CONVERSATION = /^conversations\/([^/]+)(\/summary)?$/;

const scopeOf = (agentId: string, source: string): BrainScope => ({ clientId: agentId, sourceId: source, allowedSources: [source], ...(hasPlacePrefix(source) ? { placeAgent: agentId } : {}) });

type Resolved = { place: Extract<PlaceRef, { kind: "place" }> } | { reason: string };

async function placeOfChannel(d: MoveDeps, channel: string, known: Array<{ teamId: string; channel: string }>): Promise<Resolved> {
  const teams = [...new Set(known.filter((k) => k.channel.toLowerCase() === channel.toLowerCase()).map((k) => k.teamId))];
  if (teams.length === 0) return { reason: "no session has been seen in its channel, so its place is unknown" };
  if (teams.length > 1) return { reason: "its channel id is known in more than one workspace" };
  const real = known.find((k) => k.channel.toLowerCase() === channel.toLowerCase())!.channel;
  const ref = await d.place({ agentId: d.agentId, teamId: teams[0]!, channel: real, personaId: d.personaId });
  return ref.kind === "place" ? { place: ref } : { reason: `its place cannot be worked out (${ref.reason})` };
}

async function pageText(d: MoveDeps, source: string, slug: string): Promise<string | null> {
  const raw = (await getPageOrNull(d.call, slug, scopeOf(d.agentId, source))) as { content?: unknown } | null;
  return raw && typeof raw.content === "string" ? raw.content : null;
}

async function timelineCount(d: MoveDeps, source: string, slug: string): Promise<number> {
  const rows = await d.call("get_timeline", { slug }, scopeOf(d.agentId, source));
  return Array.isArray(rows) ? rows.length : 0;
}

/** Whether the place already holds this page: reads only, and only a place the registry binds (an unbound one holds nothing). */
async function statusIn(d: MoveDeps, place: Extract<PlaceRef, { kind: "place" }>, slug: string, text: string, conversation: boolean, sourceRows: number): Promise<MoveStatus> {
  if (!(await placeBound(d.agentId, place.source))) return "new";
  if (conversation) {
    const have = await timelineCount(d, place.source, slug);
    if (have === 0) return "new";
    return have >= sourceRows ? "there" : "conflict";
  }
  const there = await pageText(d, place.source, slug);
  if (there === null) return "new";
  return there === text ? "there" : "conflict";
}

/** Classify every page of the persona's slice. Reads only. */
export async function planMove(d: MoveDeps): Promise<MovePlan> {
  const agentSource = agentSourceId(d.agentId);
  const pages = (await d.listPages(agentSource)).sort((a, b) => a.slug.localeCompare(b.slug));
  const known = await d.channels();
  const items: MoveItem[] = [];
  const review: ReviewItem[] = [];
  for (const p of pages) {
    try {
      const hb = HEARTBEAT.exec(p.slug);
      const conv = CONVERSATION.exec(p.slug);
      let target: Resolved | null = null;
      let kind: MoveKind | null = null;
      if (hb) {
        kind = "checklist";
        target = await placeOfChannel(d, hb[1]!, known);
      } else if (conv) {
        kind = conv[2] ? "summary" : "conversation";
        const s = await d.session(conv[1]!);
        if (!s || !s.channel) target = { reason: "no session row names its place" };
        else if (!s.teamId) target = { reason: "its session has no workspace" };
        else {
          const ref = await d.place({ agentId: d.agentId, teamId: s.teamId, channel: s.channel, ...(s.threadTs ? { threadTs: s.threadTs } : {}), sessionId: conv[1]!, personaId: d.personaId });
          target = ref.kind === "place" ? { place: ref } : { reason: `its place cannot be worked out (${ref.reason})` };
        }
      } else if (p.type === "commitment") {
        kind = "commitment";
        const text = await pageText(d, agentSource, p.slug);
        const thread = parseThread(text ? readPageRecord({ content: text, tags: [] })?.meta.thread : undefined);
        target = thread ? await placeOfChannel(d, thread.channelId, known) : { reason: "it names no thread" };
      }
      if (!kind || !target) {
        review.push({ slug: p.slug, type: p.type, reason: "not attributable to one place" });
        continue;
      }
      if ("reason" in target) {
        review.push({ slug: p.slug, type: p.type, reason: target.reason });
        continue;
      }
      const text = (await pageText(d, agentSource, p.slug)) ?? "";
      const rows = kind === "conversation" ? await timelineCount(d, agentSource, p.slug) : 0;
      items.push({ slug: p.slug, kind, place: target.place, status: await statusIn(d, target.place, p.slug, text, kind === "conversation", rows) });
    } catch (e) {
      review.push({ slug: p.slug, type: p.type, reason: `could not be classified (${e instanceof Error ? e.name : typeof e})` });
    }
  }
  return { agentSource, items, review };
}

export interface MoveResult {
  copied: number;
  failed: Array<{ slug: string; error: string }>;
}

/** Copy every `new` item into its place. Never deletes, never overwrites; an item that fails is reported and the rest go on. */
export async function applyMove(d: MoveDeps, plan: MovePlan): Promise<MoveResult> {
  const out: MoveResult = { copied: 0, failed: [] };
  for (const it of plan.items) {
    if (it.status !== "new") continue;
    try {
      if (!(await d.bind(it.place))) throw new Error("the place could not be bound in the registry");
      const text = await pageText(d, plan.agentSource, it.slug);
      if (text === null) throw new Error("the page is gone from the persona slice");
      const into = scopeOf(d.agentId, it.place.source);
      // Re-check right before writing: a replica or a second run may have copied it meanwhile.
      if (it.kind === "conversation") {
        if ((await timelineCount(d, it.place.source, it.slug)) > 0) continue;
      } else if ((await pageText(d, it.place.source, it.slug)) !== null) continue;
      await d.call("put_page", { slug: it.slug, content: text }, into);
      if (it.kind === "conversation") {
        const rows = await d.call("get_timeline", { slug: it.slug }, scopeOf(d.agentId, plan.agentSource));
        const ordered = (Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : []).sort((a, b) => Number(a.id ?? 0) - Number(b.id ?? 0));
        for (const r of ordered) {
          await d.call(
            "add_timeline_entry",
            { slug: it.slug, date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date ?? "").slice(0, 10), source: "slack-turn", summary: String(r.summary ?? ""), detail: r.detail == null ? undefined : String(r.detail) },
            into,
          );
        }
      }
      out.copied++;
    } catch (e) {
      out.failed.push({ slug: it.slug, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

const count = (items: MoveItem[], f: (i: MoveItem) => boolean): number => items.filter(f).length;

/** The report: counts and slugs only, never page text. */
export function formatMove(plan: MovePlan, o: { apply: boolean; result?: MoveResult }): string {
  const lines: string[] = [];
  const todo = plan.items.filter((i) => i.status === "new");
  lines.push(`memory places move (${o.apply ? "apply" : "dry run"}), source ${plan.agentSource}`);
  const kinds: MoveKind[] = ["checklist", "conversation", "summary", "commitment"];
  lines.push(`  to copy: ${todo.length} (${kinds.map((k) => `${k} ${count(todo, (i) => i.kind === k)}`).join(", ")})`);
  lines.push(`  already in their place: ${count(plan.items, (i) => i.status === "there")}`);
  lines.push(`  conflicts, left as they are: ${count(plan.items, (i) => i.status === "conflict")}`);
  lines.push(`  places involved: ${new Set(plan.items.map((i) => i.place.boundaryId)).size}`);
  lines.push(`  review list (stays persona-wide): ${plan.review.length}`);
  if (o.result) {
    lines.push(`  copied: ${o.result.copied}; failed: ${o.result.failed.length}; originals are kept`);
    for (const f of o.result.failed) lines.push(`    failed ${f.slug}: ${f.error.slice(0, 120)}`);
  } else if (!o.apply) {
    lines.push("  nothing was written; run again with --apply to copy (originals are kept)");
  }
  for (const i of plan.items.filter((x) => x.status !== "there")) lines.push(`  ${i.status === "new" ? "copy" : "conflict"} ${i.slug} (${i.kind}) -> place ${i.place.boundaryId.slice(0, 8)}`);
  for (const r of plan.review) lines.push(`  review ${r.slug} (${r.type}): ${r.reason}`);
  return lines.join("\n");
}
