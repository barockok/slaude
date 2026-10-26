/**
 * The weekly digest (spec §9.1 "Weekly digest", §9.2, §9.3; Task 9 ruling E):
 * Monday 09:00 persona-local (slot = the ISO week), one message to the
 * manager's DM (the backup manager's only when no manager is set), posted as
 * the group persona's own Slack app, covering the previous Monday to Sunday:
 *   - spend against the budget, per day;
 *   - runs by pass and outcome;
 *   - the passes skipped for budget (listed here, never messaged);
 *   - lessons added and dropped since the last digest that reached someone;
 *   - skills written and retired, each retired one with Restore;
 *   - the open manager proposals, each with Approve and Reject.
 * A person's proposal never appears here, nor whose private conversations a
 * skipped pass covered: skipped runs are counted per pass and day only.
 *
 * Lesson changes are the `self/lessons` page diffed by line against the
 * snapshot the previous digest stored in its own slot row
 * (`background_slots.state`, migration 0025). A digest stores its snapshot only
 * when it reached at least one recipient, so changes nobody saw roll into the
 * next one. The first digest has no snapshot and lists the lessons as they are.
 *
 * The digest uses no model. Its ledger row (pass `digest`, cost 0) is `ok`
 * when it was sent, and also when there is nobody to send it to (no manager
 * configured, logged); `error` when every post failed.
 */
import * as Runs from "../db/background-runs";
import type { BackgroundRun } from "../db/background-runs";
import { previousSlotState, setSlotState } from "../db/background-slots";
import * as Proposals from "../db/proposals";
import type { Proposal } from "../db/proposals";
import * as Sessions from "../db/sessions";
import { redactSecrets } from "../gateway/core/status-text";
import type { AppRef } from "../gateway/core/transport";
import { readPageRecord } from "../knowledge/memory-pages";
import { getPageOrNull, type BrainOpCall } from "../knowledge/memory-trail";
import { agentSourceId } from "../knowledge/scope";
import { m as metric } from "../metrics";
import type { Skill } from "../skills/loader";
import { localDay, type BudgetConfig } from "./budget";
import { localParts, previousDay } from "./calendar";
import { budgetConfigFor } from "./config";
import { LESSONS_SLUG } from "./passes/lessons-upkeep";
import { ownSkills } from "./passes/skill-review";
import { escapeMrkdwn, proposalBlocks, retiredSkillBlocks, type Block, type CardPost } from "./proposal-cards";
import type { AgentGroup } from "./scheduler";

export const DIGEST = "digest" as const;
/** Slack refuses a message with more blocks than this. */
export const MAX_BLOCKS = 50;
/** Most proposals carded in one digest; the rest wait for a later one (until they expire). */
export const MAX_DIGEST_PROPOSALS = 8;
/** Most retired skills listed with Restore in one digest. */
export const MAX_DIGEST_RETIREMENTS = 3;
const SECTION_CHARS = 2900;

export interface LessonChanges {
  added: string[];
  dropped: string[];
  /** Lines on the page now. */
  total: number;
  /** No earlier digest stored a snapshot: `added` is the page as it is. */
  first: boolean;
}

export interface DigestInput {
  /** The digest's slot (ISO week it is sent in). */
  week: string;
  /** The seven persona-local days covered, oldest first. */
  days: string[];
  limitUsd: number;
  runs: BackgroundRun[];
  /** null when the lessons page could not be read. */
  lessons: LessonChanges | null;
  skillsAdded: Array<{ slug: string; at: string }>;
  retirements: Proposal[];
  proposals: Proposal[];
}

const usd = (n: number): string => `$${n.toFixed(4)}`;
const clipSection = (s: string): string => (s.length <= SECTION_CHARS ? s : s.slice(0, SECTION_CHARS - 1) + "…");
const section = (text: string): Block => ({ type: "section", text: { type: "mrkdwn", text: clipSection(text) } });
const shownLine = (s: string): string => escapeMrkdwn(redactSecrets(s.length <= 200 ? s : s.slice(0, 199) + "…"));

/** The digest message, from the ledger, the lesson diff, the skill events and the open manager proposals. */
export function renderDigest(input: DigestInput): { text: string; blocks: Block[] } {
  const covered = new Set(input.days);
  const runs = input.runs.filter((r) => covered.has(r.day));
  const title = `Weekly digest, ${input.days[0]} to ${input.days[input.days.length - 1]}`;

  const spent = new Map<string, number>();
  for (const r of runs) spent.set(r.day, (spent.get(r.day) ?? 0) + r.costUsd);
  const total = [...spent.values()].reduce((a, b) => a + b, 0);
  const spend = [
    `*Spend against the budget* (${usd(input.limitUsd)} a day)`,
    ...input.days.map((d) => {
      const s = spent.get(d) ?? 0;
      return `${d}: ${usd(s)} of ${usd(input.limitUsd)}${s > input.limitUsd + 1e-9 ? " (over)" : ""}`;
    }),
    `Week: ${usd(total)} of ${usd(input.limitUsd * input.days.length)}`,
  ].join("\n");

  const byPass = new Map<string, Map<string, number>>();
  for (const r of runs) {
    const m = byPass.get(r.pass) ?? new Map<string, number>();
    const o = r.outcome ?? "running";
    m.set(o, (m.get(o) ?? 0) + 1);
    byPass.set(r.pass, m);
  }
  const runLines = [...byPass.keys()].sort().map((p) => {
    const m = byPass.get(p)!;
    return `${p}: ${[...m.keys()].sort().map((o) => `${o} ${m.get(o)}`).join(", ")}`;
  });
  const runsText = ["*Runs by pass and outcome*", ...(runLines.length > 0 ? runLines : ["No background runs this week."])].join("\n");

  // Per pass and day only: a skipped run's scope can name a person.
  const skipped = new Map<string, number>();
  for (const r of runs) if (r.outcome === "skipped-budget") skipped.set(`${r.day} ${r.pass}`, (skipped.get(`${r.day} ${r.pass}`) ?? 0) + 1);
  const skippedLines = [...skipped.keys()].sort().map((k) => `${k}${skipped.get(k)! > 1 ? ` (${skipped.get(k)}×)` : ""}`);
  const skippedText = ["*Skipped for budget*", ...(skippedLines.length > 0 ? skippedLines : ["None."])].join("\n");

  let lessonsText: string;
  const l = input.lessons;
  if (!l) lessonsText = "*Lessons*\nThe lessons page could not be read this week.";
  else if (l.first) lessonsText = [`*Lessons* (first digest: the page as it is, ${l.total} lines)`, ...l.added.map((x) => `+ ${shownLine(x)}`)].join("\n");
  else if (l.added.length === 0 && l.dropped.length === 0) lessonsText = `*Lessons*\nNo change (${l.total} lines).`;
  else lessonsText = [`*Lessons* (${l.total} lines now)`, ...l.added.map((x) => `+ ${shownLine(x)}`), ...l.dropped.map((x) => `− ${shownLine(x)}`)].join("\n");

  const skillsText = [
    "*Skills*",
    input.skillsAdded.length > 0 ? `Written or revised: ${input.skillsAdded.map((s) => `\`${shownLine(s.slug)}\` (${s.at})`).join(", ")}` : "None written.",
    input.retirements.length > 0 ? `Retired: ${input.retirements.length}` : "None retired.",
  ].join("\n");

  const blocks: Block[] = [
    { type: "header", text: { type: "plain_text", text: title } },
    section(spend),
    section(runsText),
    section(skippedText),
    section(lessonsText),
    section(skillsText),
  ];
  for (const r of input.retirements.slice(0, MAX_DIGEST_RETIREMENTS)) blocks.push(...retiredSkillBlocks(r));
  if (input.retirements.length > MAX_DIGEST_RETIREMENTS) blocks.push(section(`${input.retirements.length - MAX_DIGEST_RETIREMENTS} more retired; ask to see them.`));

  const open = input.proposals.filter((p) => p.status === "open" && p.toKind === "manager");
  blocks.push(section(open.length > 0 ? `*Proposals for you* (${open.length} open; nothing is written until you approve)` : "*Proposals for you*\nNone open."));
  for (const p of open.slice(0, MAX_DIGEST_PROPOSALS)) blocks.push({ type: "divider" }, ...proposalBlocks(p));
  if (open.length > MAX_DIGEST_PROPOSALS) blocks.push(section(`${open.length - MAX_DIGEST_PROPOSALS} more open; they come in a later digest until they expire.`));

  const text = `${title}: ${usd(total)} spent, ${skippedLines.length} skipped, ${open.length} open proposal${open.length === 1 ? "" : "s"}`;
  return { text, blocks: blocks.slice(0, MAX_BLOCKS) };
}

/** The digest's one recipient: the manager, else the backup manager (only when no manager is set), else nobody. */
export function digestRecipientOf(soul: { manager: { userId?: string }; backupManager: { userId?: string } }): string | null {
  return soul.manager.userId || soul.backupManager.userId || null;
}

/** The Monday-to-Sunday week before the persona-local day `today`. */
export function coveredDays(now: Date, timeZone: string): string[] {
  const t = localParts(now, timeZone);
  let monday = t.day;
  for (let i = 1; i < t.weekday; i++) monday = previousDay(monday);
  const days: string[] = [];
  let d = monday;
  for (let i = 0; i < 7; i++) days.unshift((d = previousDay(d)));
  return days;
}

const lessonLines = (body: string): string[] => body.split(/\r?\n/).map((x) => x.trim()).filter((x) => x !== "");

/** Lines in `now` not in `prev`, and the reverse. */
export function diffLessons(prev: string[] | null, now: string[]): LessonChanges {
  if (prev === null) return { added: now, dropped: [], total: now.length, first: true };
  const p = new Set(prev);
  const n = new Set(now);
  return { added: now.filter((x) => !p.has(x)), dropped: prev.filter((x) => !n.has(x)), total: now.length, first: false };
}

export interface DigestDeps {
  call: BrainOpCall;
  /** Absent: there is no Slack to post through; the digest is logged and recorded, not sent. */
  post?: CardPost;
  /** Whom the digest goes to: the manager, else the backup manager, else nobody. */
  recipient: () => string | null;
  budget?: (personaId: string) => BudgetConfig;
  /** The persona's own skills. Default: the skill review's view. */
  skills?: (personaId: string) => Skill[];
  /** The Slack app to post as. Default: the group persona's own app (personaApp). */
  app?: (g: AgentGroup) => Promise<AppRef | undefined>;
}

/**
 * The persona's own Slack app: from that persona's sessions only (never
 * another persona's in the group), preferring one that recorded its app id.
 * Undefined when the persona has no session yet.
 */
export async function personaApp(personaId: string): Promise<AppRef | undefined> {
  const s = await Sessions.latestAppOf(personaId);
  if (!s) return undefined;
  return { ...(s.apiAppId ? { apiAppId: s.apiAppId } : {}), ...(s.teamId ? { teamId: s.teamId } : {}) };
}

interface Snapshot {
  lessons: string[];
}

const parseSnapshot = (s: string): Snapshot | null => {
  try {
    const v = JSON.parse(s) as Snapshot;
    return Array.isArray(v?.lessons) ? { lessons: v.lessons.filter((x) => typeof x === "string") } : null;
  } catch {
    return null;
  }
};

const errText = (e: unknown): string => redactSecrets(e instanceof Error ? e.message : String(e));

/** Build and send one agent group's digest for `slot`; the outcome is recorded in the ledger. */
export async function runDigest(r: AgentGroup & { slot: string; now: Date }, deps: DigestDeps): Promise<{ outcome: Runs.RunOutcome; sentTo: string[] }> {
  const tag = `[background] agent=${r.agentId} pass=${DIGEST} slot=${r.slot}`;
  const cfg = (deps.budget ?? budgetConfigFor)(r.personaId);
  const runId = await Runs.start({ agentId: r.agentId, pass: DIGEST, scope: "agent", day: localDay(r.now, cfg.timeZone), startedAt: r.now.getTime(), model: null });
  const finish = async (outcome: Runs.RunOutcome, sentTo: string[]) => {
    await Runs.finish(runId, { tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, costUsd: 0, outcome });
    metric.backgroundRunsTotal.inc({ agent: r.agentId, pass: DIGEST, outcome });
    return { outcome, sentTo };
  };
  try {
    const days = coveredDays(r.now, cfg.timeZone);
    const from = days[0]!;
    const to = days[days.length - 1]!;
    const inWeek = (ms: number) => {
      const d = localDay(new Date(ms), cfg.timeZone);
      return d >= from && d <= to;
    };
    const runs = await Runs.listBetween(r.agentId, from, to);
    const proposals = await Proposals.listOpen(r.agentId, "manager");
    const retirements = (await Proposals.listSkillRetirements(r.agentId, Date.parse(`${previousDay(from)}T00:00:00Z`))).filter((x) => inWeek(x.createdAt));
    const skillsAdded = (deps.skills ?? ownSkills)(r.personaId)
      .filter((s) => s.authoredBy === "agent" && s.authoredAt !== undefined && Number.isFinite(Date.parse(s.authoredAt)) && inWeek(Date.parse(s.authoredAt)))
      .map((s) => ({ slug: s.slug, at: localDay(new Date(Date.parse(s.authoredAt!)), cfg.timeZone) }));

    let lessons: LessonChanges | null = null;
    let current: string[] | null = null;
    try {
      const source = agentSourceId(r.agentId);
      const rec = readPageRecord(await getPageOrNull(deps.call, LESSONS_SLUG, { clientId: r.agentId, sourceId: source, allowedSources: [source] }));
      current = lessonLines(rec?.body ?? "");
      const prev = await previousSlotState(r.agentId, DIGEST, r.slot);
      lessons = diffLessons(prev ? (parseSnapshot(prev.state)?.lessons ?? null) : null, current);
    } catch (e) {
      console.error(`${tag}: could not read the lessons page: ${errText(e)}`);
    }

    const msg = renderDigest({ week: r.slot, days, limitUsd: cfg.limitUsd, runs, lessons, skillsAdded, retirements, proposals });
    const recipient = deps.recipient();
    const recipients = recipient ? [recipient] : [];
    if (recipients.length === 0) {
      console.log(`${tag}: no manager configured in the SOUL; the digest was not sent`);
      return finish("ok", []);
    }
    if (!deps.post) {
      console.log(`${tag}: no Slack client to post with; the digest was not sent`);
      return finish("ok", []);
    }
    const app = await (deps.app ?? ((g: AgentGroup) => personaApp(g.personaId)))(r).catch(() => undefined);
    const sentTo: string[] = [];
    for (const u of recipients) {
      try {
        await deps.post({ channel: u, ...(app ? { app } : {}), text: msg.text, blocks: msg.blocks });
        sentTo.push(u);
      } catch (e) {
        console.error(`${tag}: could not post the digest to ${u}: ${errText(e)}`);
      }
    }
    if (sentTo.length === 0) return finish("error", []);
    // Bind the cards to the app they went out as: a click must come through it.
    if (app) {
      const shown = [...proposals.filter((p) => p.status === "open" && p.toKind === "manager"), ...retirements].map((p) => p.id);
      await Proposals.stampApp(shown, app).catch((e) => console.error(`${tag}: could not record the cards' Slack app: ${errText(e)}`));
    }
    if (current !== null) {
      await setSlotState(r.agentId, DIGEST, r.slot, JSON.stringify({ lessons: current } satisfies Snapshot)).catch((e) =>
        console.error(`${tag}: sent, but could not store the lessons snapshot: ${errText(e)}`),
      );
    }
    console.log(`${tag}: sent to ${sentTo.length} recipient(s)`);
    return finish("ok", sentTo);
  } catch (e) {
    console.error(`${tag}: failed: ${errText(e)}`);
    return finish("error", []);
  }
}
