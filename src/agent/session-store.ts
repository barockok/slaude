/**
 * SessionStore seam (spec §6 "AgentManager changes").
 *
 * AgentManager persists session state through this interface instead of
 * importing the db repo directly, so the same manager runs against:
 *
 *   - `dbSessionStore` (default) — the src/db/sessions repo (sqlite or
 *     Postgres via the DbClient seam). Used by mono and gateway roles.
 *   - the REST implementation (src/node/session-store.ts) — /v1/sessions on
 *     the gateway. Used by node workers, which have no database.
 *
 * The surface is exactly what AgentManager uses today — one method per repo
 * function it called. Injecting the default is a zero-behavior change.
 */
import * as Sessions from "../db/sessions";
import type { ThreadKey } from "../db/sessions";
import type { SessionRow } from "../db/schema";

export type { ThreadKey, SessionRow };

export interface SessionStore {
  findById(id: string): Promise<SessionRow | null>;
  findByThread(k: ThreadKey): Promise<SessionRow | null>;
  createForThread(args: {
    thread: ThreadKey;
    model: string;
    working_dir: string;
    title?: string;
    permission_mode?: string;
  }): Promise<SessionRow>;
  markStarted(id: string): Promise<void>;
  clearStarted(id: string): Promise<void>;
  setStatus(id: string, status: string): Promise<void>;
  setPermissionMode(id: string, mode: string): Promise<void>;
  setModel(id: string, model: string): Promise<void>;
}

/** Default implementation: the db repo, unchanged. */
export const dbSessionStore: SessionStore = {
  findById: (id) => Sessions.findById(id),
  findByThread: (k) => Sessions.findByThread(k),
  createForThread: (args) => Sessions.createForThread(args),
  markStarted: (id) => Sessions.markStarted(id),
  clearStarted: (id) => Sessions.clearStarted(id),
  setStatus: (id, status) => Sessions.setStatus(id, status),
  setPermissionMode: (id, mode) => Sessions.setPermissionMode(id, mode),
  setModel: (id, model) => Sessions.setModel(id, model),
};
