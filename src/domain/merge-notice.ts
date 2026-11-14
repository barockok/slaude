/**
 * The Slack notice a merge sends (slice C, task 27). The engine calls
 * `queueMergeNotice` once, after the merge commits (`emitDomainEvents`).
 *
 * What it sends
 *  - One DM to the person: what was linked (an email only masked, `a***@example.com`;
 *    never a Slack id), how many grants became active, which privileged grants stay
 *    inactive and why (with a fresh portal link when the Slack binding is not
 *    verified), and who to tell.
 *  - When a privileged grant activates, one DM to that persona's manager (D7).
 *    It names the person by masked email only.
 *
 * How it sends
 *  - Through the gateway's own outbound path: `cardPoster(transport)`, the bot of
 *    the Slack app the workspace has, registered by `createGateway`
 *    (`setMergeNoticeSender`). A node never sends. A process with no gateway (the
 *    CLI) has no sender and the notice is `failed`, which the console shows.
 *  - A single attempt. `notice_state` becomes `sent` or `failed` (or `skipped`: the
 *    switch is off, a node, nobody to tell). A failure never reverts the merge and
 *    is never retried; the audit event `user.merge_notice` says which DM failed.
 *  - `SLAUDE_MERGE_NOTICE=off` sends nothing (rollback switch for the notice alone).
 *
 * The text is never given a Slack id or an unmasked email (a wrong merge may join
 * two different people, so no value of the other record is repeated).
 */
import * as Domain from "../db/domain";
import { maskValue } from "../db/domain-read";
import { db } from "../db/schema";
import { env } from "../config/env";
import { m } from "../metrics";
import { audit } from "../audit/index";
import { mintLinkToken, LINK_TTL_SEC } from "../gateway/portal/link-token";
import { getMerge, type MergeRow } from "./merge";

export interface NoticeApp {
  apiAppId: string;
  teamId: string;
  personaId?: string;
}
export interface NoticeMessage {
  channel: string;
  app?: { apiAppId?: string; teamId?: string };
  text: string;
  blocks: Array<Record<string, unknown>>;
}
/** The gateway's outbound path for a runtime DM (`cardPoster`) and, on a multi-app transport, its registered apps. */
export interface NoticePost {
  post(msg: NoticeMessage): Promise<unknown>;
  apps?(): Promise<NoticeApp[]>;
}

let sender: NoticePost | null = null;
/** Register the gateway's sender. Returns a function that unregisters it only if it is still the registered one. */
export function setMergeNoticeSender(s: NoticePost | null): () => void {
  sender = s;
  return () => {
    if (sender === s) sender = null;
  };
}

const inflight = new Set<Promise<void>>();
const claimed = new Set<string>();

/** Queue the notice for a committed merge. Never throws, never blocks the caller. */
export function queueMergeNotice(mergeId: string): void {
  // A node never sends and never opens a database; the gateway that committed the merge sends.
  if (env.role() === "node") return;
  if (claimed.has(mergeId)) return;
  claimed.add(mergeId);
  const p = sendMergeNotice(mergeId)
    .then(() => {})
    .catch((e) => console.warn(`[merge-notice] ${mergeId}: ${(e as Error).message}`))
    .finally(() => inflight.delete(p));
  inflight.add(p);
}

/** Resolve once every queued notice has settled (tests, shutdown). */
export async function flushMergeNotices(): Promise<void> {
  while (inflight.size) await Promise.all([...inflight]);
}

type NoticeResult = "sent" | "failed" | "skipped";

const escape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

async function settle(merge: MergeRow, state: NoticeResult, detail: Record<string, unknown>): Promise<NoticeResult> {
  // Only a pending row changes: a notice settles once.
  await db.run("UPDATE user_merges SET notice_state = ? WHERE id = ? AND notice_state = 'pending'", [state, merge.id]);
  m.mergeNoticeTotal.inc({ result: state });
  await audit({
    actorKind: "system",
    actorId: "system",
    action: "user.merge_notice",
    targetKind: "user",
    targetId: merge.survivor_id,
    summary: `merge notice ${state}`,
    details: { merge_id: merge.id, result: state, ...detail },
  });
  return state;
}

/** The short reason of a failed post: Slack's error code or the error name, never a message that may carry a value. */
function whyFailed(e: unknown): string {
  const slack = (e as { data?: { error?: unknown } } | null)?.data?.error;
  if (typeof slack === "string") return slack.slice(0, 64);
  const msg = e instanceof Error ? e.message : String(e);
  return /^[a-z_]{3,48}$/.test(msg) ? msg : e instanceof Error ? e.name : "error";
}

interface Target {
  teamId: string;
  slackUserId: string;
  state: Domain.State;
}

/**
 * The Slack binding to tell: the one the proof rested on, else a verified one,
 * else one the survivor already held before the merge, else the oldest seen.
 */
function pickTarget(merge: MergeRow, bindings: Domain.BindingRow[]): Target | null {
  const slack = bindings.filter((b) => b.service === "slack" && b.kind === "user" && b.state !== "declared");
  const proof = merge.moved.proof_binding_ids.slack;
  const movedIds = new Set(merge.moved.bindings.map((b) => b.id));
  const pick = slack.find((b) => b.id === proof) ?? slack.find((b) => b.state === "verified") ?? slack.find((b) => !movedIds.has(b.id)) ?? slack[0];
  return pick ? { teamId: pick.workspace, slackUserId: pick.value, state: pick.state } : null;
}

async function appFor(s: NoticePost, teamId: string, personaId?: string): Promise<{ apiAppId?: string; teamId: string }> {
  if (!s.apps) return { teamId };
  const inTeam = (await s.apps()).filter((a) => a.teamId === teamId);
  const named = personaId && personaId !== "default" ? inTeam.find((a) => a.personaId === personaId) : undefined;
  const app = named ?? inTeam.find((a) => !a.personaId || a.personaId === "default") ?? inTeam[0];
  if (!app) throw new Error("no_slack_app_for_workspace");
  return { apiAppId: app.apiAppId, teamId };
}

function portalLink(t: Target): string | null {
  try {
    if (!env.portal.enabled() || !env.panel.publicUrl()) return null;
    return `${env.panel.publicUrl()}/portal/link?t=${mintLinkToken({ teamId: t.teamId, slackUserId: t.slackUserId })}`;
  } catch {
    return null;
  }
}

interface Facts {
  merge: MergeRow;
  /** Masked addresses now held by the survivor among the moved bindings. */
  emails: string[];
  slackCount: number;
  otherCount: number;
  hasVerifiedSlack: boolean;
  /** Masked verified address of the survivor, for the manager's text. */
  who: string;
}

/** The text to the person. Pure; exported for tests. */
export function personText(f: Facts, link: string | null): string {
  const { merge } = f;
  const mv = merge.moved;
  const how = merge.kind === "proof" ? "after you proved the link between your Slack account and your sign-in" : "by an operator in the console";
  const parts: string[] = [];
  if (f.slackCount > 0) parts.push(plural(f.slackCount, "Slack account", "Slack accounts"));
  if (f.emails.length > 0) parts.push(`the address ${f.emails.map(escape).join(", ")}`);
  if (f.otherCount > 0) parts.push(plural(f.otherCount, "other identity", "other identities"));
  const lines = [`:link: Two records of you were linked ${how}.`];
  lines.push(`Linked: ${parts.length ? parts.join(" and ") : "an empty record"}.`);
  const act = mv.activated.map((a) => `${escape(a.persona)} (${escape(a.role)})`);
  lines.push(
    mv.activated.length === 0
      ? "Grants that became active for you: none."
      : `Grants that became active for you: ${plural(mv.activated.length, "grant", "grants")} (${act.join(", ")}).`,
  );
  if (mv.inactive_privileged.length > 0) {
    const names = mv.inactive_privileged.map((g) => `${escape(g.persona)} (${escape(g.role)})`).join(", ");
    const why = f.hasVerifiedSlack
      ? "the matching email address is not verified yet: sign in to the portal with your account"
      : "your Slack account is not verified through the portal yet";
    lines.push(`${plural(mv.inactive_privileged.length, "privileged grant stays", "privileged grants stay")} inactive: ${names}, because ${why}.`);
    if (link) lines.push(`Link your Slack account here (only you can see this, it expires in ${LINK_TTL_SEC / 60} minutes): ${link}`);
  }
  lines.push(`This was not you or not expected? Tell the manager of the agent or the deployment operator. A merge can be undone until ${day(merge.undo_until)}.`);
  return lines.join("\n");
}

/** The text to a persona's manager. Pure; exported for tests. */
export function managerText(f: Facts, persona: string, roles: string[]): string {
  const how = f.merge.kind === "proof" ? "automatically, after a sign-in link was proved" : "by an operator";
  const who = f.who ? `a person (${escape(f.who)})` : "a person";
  return [
    `:bust_in_silhouette: Access change on ${escape(persona)}: ${who} now holds ${escape([...new Set(roles)].join(", "))} there, because two of their records were merged ${how}.`,
    `If this is unexpected, an operator can undo the merge in the console until ${day(f.merge.undo_until)}.`,
  ].join("\n");
}

/**
 * Send the notice for one merge. Exported for tests; production goes through
 * `queueMergeNotice`. Never throws; settles `notice_state` once.
 */
export async function sendMergeNotice(mergeId: string): Promise<NoticeResult | null> {
  const merge = await getMerge(mergeId);
  if (!merge || merge.notice_state !== "pending") return null;
  if (merge.state !== "applied") return settle(merge, "skipped", { reason: "not-applied" });
  if (!env.merge.notice()) return settle(merge, "skipped", { reason: "switch-off" });
  const live = await Domain.resolveUserId(merge.survivor_id);
  if (!live) return settle(merge, "skipped", { reason: "survivor-gone" });
  const bindings = await db.query<Domain.BindingRow>("SELECT * FROM bindings WHERE user_id = ? ORDER BY created_at, id", [live]);
  const target = pickTarget(merge, bindings);
  if (!target) return settle(merge, "skipped", { reason: "no-slack-binding" });
  if (!sender) return settle(merge, "failed", { reason: "no-sender" });
  const s = sender;

  const movedIds = new Set(merge.moved.bindings.map((b) => b.id));
  const moved = bindings.filter((b) => movedIds.has(b.id));
  const verifiedMail = bindings.find((b) => b.service === "email" && b.state === "verified");
  const facts: Facts = {
    merge,
    emails: moved.filter((b) => b.service === "email").map((b) => maskValue("email", b.kind, b.value)),
    slackCount: moved.filter((b) => b.service === "slack").length,
    otherCount: moved.filter((b) => b.service !== "slack" && b.service !== "email").length,
    hasVerifiedSlack: bindings.some((b) => b.service === "slack" && b.state === "verified"),
    who: verifiedMail ? maskValue("email", verifiedMail.kind, verifiedMail.value) : "",
  };

  const send = async (channel: string, text: string, personaId?: string) => {
    const app = await appFor(s, target.teamId, personaId);
    await s.post({ channel, app, text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] });
  };

  let person: "sent" | "failed" = "sent";
  const errors: string[] = [];
  try {
    await send(target.slackUserId, personText(facts, target.state === "verified" ? null : portalLink(target)));
  } catch (e) {
    person = "failed";
    errors.push(`person:${whyFailed(e)}`);
  }

  // D7: the manager of each persona a privileged grant activated on, unless that manager is the person.
  const own = new Set(bindings.filter((b) => b.service === "slack" && b.workspace === target.teamId).map((b) => b.value));
  const byPersona = new Map<string, string[]>();
  for (const a of merge.moved.activated) if (a.privileged) byPersona.set(a.persona, [...(byPersona.get(a.persona) ?? []), a.role]);
  let managersSent = 0;
  let managersFailed = 0;
  const told = new Set<string>();
  for (const [persona, roles] of byPersona) {
    let managers: string[] = [];
    try {
      // Loaded here: the access modules import the audit and record modules that import this one.
      const { loadGrants, usersWithRole } = await import("../access/role");
      managers = usersWithRole(await loadGrants(persona), ["manager"]);
    } catch {
      /* no managers readable: nobody to tell */
    }
    for (const mgr of managers) {
      if (own.has(mgr) || told.has(`${persona}|${mgr}`)) continue;
      told.add(`${persona}|${mgr}`);
      try {
        await send(mgr, managerText(facts, persona, roles), persona);
        managersSent++;
      } catch (e) {
        managersFailed++;
        errors.push(`manager:${whyFailed(e)}`);
      }
    }
  }

  const clean = person === "sent" && managersFailed < 1;
  const state: NoticeResult = clean ? "sent" : "failed";
  return settle(merge, state, { person, managers_sent: managersSent, managers_failed: managersFailed, ...(errors.length ? { errors } : {}) });
}
