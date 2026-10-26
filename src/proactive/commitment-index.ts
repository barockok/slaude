/**
 * Keep the commitment index (src/db/commitments.ts) in step with commitment
 * pages (spec §10.1). Called after a page write has succeeded, by kb_memoize
 * and by a background pass's memoize. The page is the truth: an index failure
 * is logged and never fails the write, and a later write of the same page
 * re-indexes it.
 *
 *   status open       → upsert, with the due time parsed (due.ts)
 *   status done|dropped → close the page it supersedes and its own slug
 *   anything else       → ignored (no thread, no due, no beneficiary)
 */
import { env } from "../config/env";
import * as Commitments from "../db/commitments";
import { parseFrontmatter } from "../knowledge/memory-pages";
import { userSourceId, type BrainScope } from "../knowledge/scope";
import { parseDue, parseThread } from "./due";

export interface IndexInput {
  agentId: string;
  /** The brain source the page was written to. */
  source: string;
  slug: string;
  /** The page as written (frontmatter and body). */
  content: string;
  personaId: string;
  teamId: string | null;
  /** Whom a check of this page runs as: the person whose `user-<id>` slice holds it, else null. */
  runAs: string | null;
  /** The writer's own threads (`<channel>:<threadTs>`): a commitment is checked
   *  only in a thread it was written from, never one the page merely names. */
  allowedThreads: readonly string[];
  writtenAt: Date;
}

export type IndexResult = "indexed" | "closed" | "ignored";

/** The person a write scope's own slice belongs to, or null (agent slice, profile, shared…). */
export function runAsOf(scope: Pick<BrainScope, "sourceId" | "clientId">): string | null {
  const s = scope.sourceId;
  return s.startsWith("user-") && scope.clientId && userSourceId(scope.clientId) === s ? scope.clientId : null;
}

const userId = (v: string | undefined): string => {
  const m = /^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/.exec((v ?? "").trim());
  return m ? m[1]! : (v ?? "").trim();
};

export async function indexCommitment(i: IndexInput): Promise<IndexResult> {
  const { meta } = parseFrontmatter(i.content);
  if (meta.type !== "commitment") return "ignored";
  const tag = `[proactive] agent=${i.agentId} commitment=${i.source}/${i.slug}`;
  if (meta.status === "done" || meta.status === "dropped") {
    const status = meta.status;
    let closed = false;
    for (const slug of new Set([meta.supersedes, i.slug].filter((s): s is string => !!s))) {
      if (await Commitments.close({ agentId: i.agentId, source: i.source, slug }, status)) closed = true;
    }
    return closed ? "closed" : "ignored";
  }
  if (meta.status !== "open") return "ignored";
  const thread = parseThread(meta.thread);
  const beneficiary = userId(meta.beneficiary);
  const due = parseDue(meta.due, i.writtenAt, { pollMinutes: env.promisePollMinutes(), expireHours: env.promiseExpireHours() });
  if (!thread || !due || !/^[UW][A-Z0-9]+$/.test(beneficiary)) {
    console.log(`${tag}: not scheduled (needs thread <channel>:<ts>, a due and a beneficiary user id)`);
    return "ignored";
  }
  if (!i.allowedThreads.includes(`${thread.channelId}:${thread.threadTs}`)) {
    console.warn(`${tag}: not scheduled: its thread is not one this write came from`);
    return "ignored";
  }
  await Commitments.upsertOpen({
    agentId: i.agentId,
    source: i.source,
    slug: i.slug,
    personaId: i.personaId || "default",
    teamId: i.teamId,
    channelId: thread.channelId,
    threadTs: thread.threadTs,
    beneficiary,
    runAs: i.runAs,
    dueText: meta.due!.trim(),
    dueKind: due.kind,
    checkText: (meta.check ?? "").trim(),
    onNoChange: meta.on_no_change === "close-in-one-line" ? "close-in-one-line" : "silent",
    nextCheckAt: due.nextCheckAt,
    expiresAt: due.expiresAt,
    createdAt: i.writtenAt.getTime(),
  });
  return "indexed";
}

/** indexCommitment for each written page, best effort: a failure is logged, never thrown. */
export async function indexWritten(pages: ReadonlyArray<{ slug: string; content: string; source: string }>, ctx: Omit<IndexInput, "slug" | "content" | "source">): Promise<void> {
  for (const p of pages) {
    try {
      await indexCommitment({ ...ctx, ...p });
    } catch (e) {
      console.error(`[proactive] agent=${ctx.agentId} could not index ${p.source}/${p.slug}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
