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
 * Session creation stays a gateway concern — the enqueue path runs
 * `ensureSession` against Postgres before a job exists, so a node never
 * creates rows. findByThread/createForThread throw loudly if ever reached.
 */
import type { SessionStore, SessionRow, ThreadKey } from "../agent/session-store";
import type { NodeClient, SessionView } from "./client";

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
    permission_mode: v.permission_mode,
    engaged: v.engaged,
    persona_id: v.persona_id,
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

  async findById(id: string): Promise<SessionRow | null> {
    const v = await this.#client.getSession(id, this.#token(id));
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
    await this.#client.patchSession(id, { claude_started: 1 }, this.#token(id));
  }

  async clearStarted(id: string): Promise<void> {
    await this.#client.patchSession(id, { claude_started: 0 }, this.#token(id));
  }

  async setStatus(id: string, status: string): Promise<void> {
    await this.#client.patchSession(id, { status }, this.#token(id));
  }

  async setPermissionMode(id: string, mode: string): Promise<void> {
    await this.#client.patchSession(id, { permission_mode: mode }, this.#token(id));
  }

  async setModel(id: string, model: string): Promise<void> {
    await this.#client.patchSession(id, { model }, this.#token(id));
  }
}
