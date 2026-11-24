/**
 * Memory places: decides which place a turn belongs to (design:
 * docs/superpowers/specs/2026-11-24-memory-architecture.md). The `mb-` naming itself is in
 * ./place-id.ts, re-exported here; those two are the only files that may name the prefix.
 *
 * A place is one (agent, boundary) pair. Its gbrain source id is `mb-` plus the first 28 hex
 * characters of sha256(agentId, NUL, boundaryId): 31 characters, inside gbrain's
 * `[a-z0-9-]{1,32}`, deterministic so replicas agree without coordination.
 *
 * `placeFor` answers a place or a typed reason there is none. In rc.45 it only MEASURES: no
 * read or write decision uses the answer. So it never throws, is bounded in time, and a
 * failure is an answer (`lookup-failed`), never an error. It never inserts a boundary: first
 * sight creates them.
 */
import { env } from "../config/env";
import * as CronJobs from "../db/cron-jobs";
import * as Domain from "../db/domain";
import * as Sessions from "../db/sessions";
import { boundaryFor, boundaryLookupFailed, CHANNEL_RE } from "../domain/boundary-for";
import { placeSourceId } from "./place-id";

export { hasPlacePrefix, isPlaceSourceId, placeShortId, placeSourceId } from "./place-id";

export type NoPlaceReason = "no-boundary" | "no-team" | "lookup-failed" | "unknown-surface" | "node-no-db";
export const NO_PLACE_REASONS: readonly NoPlaceReason[] = ["no-boundary", "no-team", "lookup-failed", "unknown-surface", "node-no-db"];

export type PlaceRef =
  | { kind: "place"; source: string; boundaryId: string; boundaryKind: string }
  | { kind: "none"; reason: NoPlaceReason };

/** What the turn knows. All of it is data the gateway already holds; nothing comes from the model. */
export interface PlaceInput {
  /** The persona's own identity (anchors the place). */
  agentId: string;
  teamId: string | null | undefined;
  channel: string | null | undefined;
  /** The thread key of the turn's session row, when the caller has it. */
  threadTs?: string | null;
  personaId?: string | null;
  /** The session row to read `boundary_id` from first, when the caller has its id. */
  sessionId?: string | null;
  /** The cron job row to read `boundary_id` from, for a job turn. */
  cronJobId?: string | null;
}

export interface PlaceDeps {
  role?: () => string;
  timeoutMs?: () => number;
  sessionBoundary?: (i: PlaceInput) => Promise<string | null>;
  jobBoundary?: (id: string) => Promise<string | null>;
  /** The surface-neutral resolver: a boundary id for a channel, or null. */
  channelBoundary?: (team: string, channel: string) => Promise<string | null>;
  /** True when `channelBoundary`'s null means a failed read, not an absent boundary. */
  channelLookupFailed?: (team: string, channel: string) => boolean;
  kindOf?: (boundaryId: string) => Promise<string | null>;
  now?: () => number;
}

class Timeout extends Error {}

const KIND_CAP = 5000;
/** How long an answer is reused: a place never moves, an absent boundary may appear, a failure is retried soon. */
const TTL_PLACE_MS = 10 * 60 * 1000;
const TTL_ABSENT_MS = 30 * 1000;
const TTL_FAILED_MS = 5 * 1000;
const ANSWER_CAP = 5000;

export function createPlaceResolver(deps: PlaceDeps = {}): (i: PlaceInput) => Promise<PlaceRef> {
  const role = deps.role ?? (() => env.role());
  const timeoutMs = deps.timeoutMs ?? (() => env.boundary.timeoutMs());
  const sessionBoundary =
    deps.sessionBoundary ??
    (async (i: PlaceInput) => {
      if (i.sessionId) return Sessions.boundaryIdOfSession(i.sessionId);
      if (i.teamId && i.channel && i.threadTs) {
        return Sessions.boundaryIdOfThread({ team_id: i.teamId, channel_id: i.channel, thread_ts: i.threadTs, ...(i.personaId ? { persona_id: i.personaId } : {}) });
      }
      return null;
    });
  const jobBoundary = deps.jobBoundary ?? ((id: string) => CronJobs.boundaryIdOfJob(id));
  const channelBoundary = deps.channelBoundary ?? (async (t: string, c: string) => (await boundaryFor(t, c))?.id ?? null);
  const channelLookupFailed = deps.channelLookupFailed ?? ((t: string, c: string) => boundaryLookupFailed(t, c));
  // A boundary's kind never changes, so a positive answer is kept for the process.
  const kinds = new Map<string, string>();
  const kindOf =
    deps.kindOf ??
    (async (id: string) => {
      const hit = kinds.get(id);
      if (hit) return hit;
      const row = await Domain.getBoundary(id);
      if (!row) return null;
      if (kinds.size >= KIND_CAP) kinds.clear();
      kinds.set(id, row.kind);
      return row.kind;
    });

  const bounded = <T>(p: Promise<T>): Promise<T> => {
    p.catch(() => {}); // a read that loses the race must not become an unhandled rejection
    const ms = timeoutMs();
    if (!(ms > 0)) return p;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Timeout("timeout")), ms);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  };

  const none = (reason: NoPlaceReason): PlaceRef => ({ kind: "none", reason });
  const now = deps.now ?? Date.now;
  // The gate input is built on every tool call; a turn must not pay a read each time.
  const answers = new Map<string, { at: number; ref: PlaceRef }>();
  const ttl = (r: PlaceRef): number => (r.kind === "place" ? TTL_PLACE_MS : r.reason === "no-boundary" ? TTL_ABSENT_MS : TTL_FAILED_MS);
  const keyOf = (i: PlaceInput): string => JSON.stringify([i.agentId, i.teamId ?? null, i.channel ?? null, i.threadTs ?? null, i.personaId ?? null, i.sessionId ?? null, i.cronJobId ?? null]);

  return async function placeFor(i: PlaceInput): Promise<PlaceRef> {
    const key = keyOf(i);
    const hit = answers.get(key);
    if (hit && now() - hit.at < ttl(hit.ref)) return hit.ref;
    const ref = await resolve(i);
    if (role() !== "node") {
      answers.delete(key);
      answers.set(key, { at: now(), ref });
      while (answers.size > ANSWER_CAP) answers.delete(answers.keys().next().value as string);
    }
    return ref;
  };

  async function resolve(i: PlaceInput): Promise<PlaceRef> {
    try {
      if (role() === "node") return none("node-no-db");
      if (!i.agentId) return none("lookup-failed");
      // The row the turn belongs to is the authority: a session row, then the job row.
      let boundaryId: string | null = null;
      if (i.sessionId || (i.teamId && i.channel && i.threadTs)) boundaryId = await bounded(sessionBoundary(i));
      if (!boundaryId && i.cronJobId) boundaryId = await bounded(jobBoundary(i.cronJobId));
      if (!boundaryId) {
        if (!i.teamId) return none("no-team");
        if (!i.channel || !CHANNEL_RE.test(i.channel)) return none("unknown-surface");
        boundaryId = await bounded(channelBoundary(i.teamId, i.channel));
        if (!boundaryId) return none(channelLookupFailed(i.teamId, i.channel) ? "lookup-failed" : "no-boundary");
      }
      const boundaryKind = await bounded(kindOf(boundaryId));
      if (!boundaryKind) return none("lookup-failed");
      return { kind: "place", source: placeSourceId(i.agentId, boundaryId), boundaryId, boundaryKind };
    } catch {
      return none("lookup-failed");
    }
  }
}

let shared: ((i: PlaceInput) => Promise<PlaceRef>) | undefined;

/** The turn's place, or why there is none. Never throws; bounded by SLAUDE_BOUNDARY_TIMEOUT_MS per read. */
export const placeFor = (i: PlaceInput): Promise<PlaceRef> => (env.memory.boundaries() === "off" ? Promise.resolve(NO_PLACE) : (shared ??= createPlaceResolver())(i));

/** The answer where there is no turn to ask about (an approval card, a test) or the flag is `off`: none, unknown surface. */
export const NO_PLACE: PlaceRef = { kind: "none", reason: "unknown-surface" };
