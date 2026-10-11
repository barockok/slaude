/**
 * SessionStore over the gateway REST /v1/sessions (spec §6): the node worker
 * injects this into AgentManager so the manager persists session state
 * without a database.
 *
 * Auth: every /v1/sessions call needs the per-job JWT. The worker registers
 * each job's token before running the turn (`bindToken`); the store resolves
 * it per call so a coalesced follow-up job's fresher token replaces the one
 * about to expire.
 *
 * A warm session outlives its job: the idle TTL starts after the last turn
 * and is as long as the token's TTL, so the teardown status write always
 * holds an expired token. A call refused as expired exchanges the token once
 * through /v1/jobs/:id/token-refresh (within the gateway's refresh grace) and
 * retries; any other refusal fails that call alone.
 *
 * Session creation stays a gateway concern — the enqueue path runs
 * `ensureSession` against Postgres before a job exists, so a node never
 * creates rows. findByThread/createForThread throw loudly if ever reached.
 */
import type { SessionStore, SessionRow, ThreadKey } from "../agent/session-store";
import { NodeApiError, type NodeClient, type SessionView } from "./client";
import { decodeClaims } from "./remote";

function toRow(v: SessionView): SessionRow {
  return {
    id: v.id,
    created_at: v.created_at,
    updated_at: v.updated_at,
    title: v.title,
    model: v.model,
    working_dir: v.working_dir,
    status: v.status,
    claude_started: v.claude_started,
    slack_team_id: v.slack_team_id,
    slack_channel_id: v.slack_channel_id,
    slack_thread_ts: v.slack_thread_ts,
    slack_app_id: v.slack_app_id ?? null,
    permission_mode: v.permission_mode,
    engaged: v.engaged,
    persona_id: v.persona_id,
    // Mirror the gateway's dialect: Postgres rows include tenant_id.
    ...((v as any).tenant_id !== undefined ? { tenant_id: (v as any).tenant_id } : {}),
  };
}

export class RestSessionStore implements SessionStore {
  #client: NodeClient;
  #tokens = new Map<string, string>();

  constructor(client: NodeClient) {
    this.#client = client;
  }

  /** Register (or refresh) the job token used for this session's calls. */
  bindToken(sessionId: string, jobToken: string): void {
    this.#tokens.set(sessionId, jobToken);
  }

  /** Drop the token once the session is fully closed on this node. */
  unbindToken(sessionId: string): void {
    this.#tokens.delete(sessionId);
  }

  tokenFor(sessionId: string): string | undefined {
    return this.#tokens.get(sessionId);
  }

  #token(sessionId: string): string {
    const t = this.#tokens.get(sessionId);
    if (!t) throw new Error(`no job token bound for session ${sessionId} — worker must bindToken before the turn`);
    return t;
  }

  /** Run `call` on the session's token; on an expired-token 401, refresh the
   *  token once (rebinding it unless a newer job bound another meanwhile) and
   *  retry. A failed refresh rethrows the original refusal. */
  async #withToken<T>(id: string, call: (token: string) => Promise<T>): Promise<T> {
    const token = this.#token(id);
    try {
      return await call(token);
    } catch (e) {
      const job = decodeClaims(token)?.job;
      if (!(e instanceof NodeApiError && e.status === 401 && /expired/.test(e.body)) || typeof job !== "string") throw e;
      let fresh: string;
      try {
        fresh = await this.#client.refreshJobToken(job, token);
      } catch (re) {
        console.warn(`[node] session token refresh failed session=${id} job=${job}: ${re instanceof Error ? re.message : String(re)}`);
        throw e;
      }
      if (this.#tokens.get(id) === token) this.#tokens.set(id, fresh);
      return await call(fresh);
    }
  }

  async findById(id: string): Promise<SessionRow | null> {
    const v = await this.#withToken(id, (t) => this.#client.getSession(id, t));
    return v ? toRow(v) : null;
  }

  async findByThread(_k: ThreadKey): Promise<SessionRow | null> {
    throw new Error("RestSessionStore.findByThread: session lookup by thread is gateway-only (nodes receive sessionIds via jobs)");
  }

  async createForThread(_args: {
    thread: ThreadKey;
    model: string;
    working_dir: string;
    title?: string;
    permission_mode?: string;
  }): Promise<SessionRow> {
    throw new Error("RestSessionStore.createForThread: session creation is gateway-only (ensureSession runs on enqueue)");
  }

  async markStarted(id: string): Promise<void> {
    await this.#withToken(id, (t) => this.#client.patchSession(id, { claude_started: 1 }, t));
  }

  async clearStarted(id: string): Promise<void> {
    await this.#withToken(id, (t) => this.#client.patchSession(id, { claude_started: 0 }, t));
  }

  async setStatus(id: string, status: string): Promise<void> {
    await this.#withToken(id, (t) => this.#client.patchSession(id, { status }, t));
  }

  async setPermissionMode(id: string, mode: string): Promise<void> {
    await this.#withToken(id, (t) => this.#client.patchSession(id, { permission_mode: mode }, t));
  }

  async setModel(id: string, model: string): Promise<void> {
    await this.#withToken(id, (t) => this.#client.patchSession(id, { model }, t));
  }
}
