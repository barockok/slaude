/**
 * Node-side MCP credentials: the pod-local working copy of whatever the gateway
 * hands this turn's owner.
 *
 * A node holds access tokens only — the gateway's endpoint returns an
 * allowlisted projection, never a refresh token or client secret — so nothing
 * here can mint or rotate a credential. That makes this module small on
 * purpose: write what the gateway sent, read it back, and never let it leave
 * the pod.
 *
 * Nothing here logs a token. Failures name the directory's session, never
 * contents.
 */
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { NodeCredential } from "../gateway/api/mcp-credentials";

const FILE = ".credentials.json";

/** The existing file's contents, or {} when absent, unreadable, or a symlink.
 *  A symlink is never followed: whatever it points at is not this pod's. */
function readOwn(path: string): Record<string, unknown> {
  try {
    if (lstatSync(path).isSymbolicLink()) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Replace the mcpOAuth subtree of a session's credentials file with exactly
 * `entries`, preserving every other key (the agent's own login lives in the
 * same file). Wholesale, so a previous owner's tokens can never survive into a
 * turn that runs as someone else.
 *
 * Written to a temp file in the same directory and renamed into place at 0600.
 * The rename replaces a symlink rather than writing through it, so the tokens
 * land in this pod-local directory and nowhere else.
 */
export async function seedCredentials(configDir: string, entries: Record<string, NodeCredential>): Promise<void> {
  const path = join(configDir, FILE);
  const next = { ...readOwn(path), mcpOAuth: entries };
  const tmp = join(configDir, `${FILE}.tmp-${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(tmp, JSON.stringify(next), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

/** The mcpOAuth subtree currently on disk, or {} when there is none. */
export function snapshotCredentials(configDir: string): Record<string, NodeCredential> {
  const m = readOwn(join(configDir, FILE)).mcpOAuth;
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, NodeCredential>) : {};
}

export interface SessionSeederDeps {
  /** Fetch this owner's access tokens from the gateway (NodeClient.getMcpCredentials). */
  fetch: (tenantId: string, jobToken: string) => Promise<Record<string, NodeCredential>>;
  tenantFor: (sessionId: string) => string | undefined;
  tokenFor: (sessionId: string) => string | undefined;
  log?: (message: string) => void;
}

/** A failure described by its kind and status only. An error's message can
 *  carry a response body, and a response body is not something to log here. */
function describeFailure(e: unknown): string {
  const status = (e as { status?: unknown })?.status;
  if (typeof status === "number") return `status=${status}`;
  return `error=${e instanceof Error ? e.name : typeof e}`;
}

/**
 * When and how a node session's credentials are seeded.
 *
 * atBoot — before the agent child starts. A failed fetch seeds an EMPTY set:
 *   booting with stale tokens from some earlier owner would be worse than
 *   booting with none, which surfaces as an ordinary connect prompt.
 * atTurn — before each turn of a warm session, so tokens the gateway refreshed
 *   since boot are picked up (the agent reads the file on every call). A failed
 *   fetch keeps the current file: within a warm session the owner has not
 *   changed — a /1on1 lock flip reboots the session, which goes through atBoot.
 */
export function makeSessionSeeder(deps: SessionSeederDeps) {
  const log = deps.log ?? ((m: string) => console.warn(m));

  async function fetchFor(sessionId: string): Promise<Record<string, NodeCredential> | null> {
    const tenant = deps.tenantFor(sessionId);
    const token = deps.tokenFor(sessionId);
    if (!tenant || !token) return null;
    try {
      return await deps.fetch(tenant, token);
    } catch (e) {
      log(`[node] MCP credential fetch failed session=${sessionId} ${describeFailure(e)}`);
      return null;
    }
  }

  return {
    async atBoot(sessionId: string, configDir: string): Promise<void> {
      await seedCredentials(configDir, (await fetchFor(sessionId)) ?? {});
    },
    async atTurn(sessionId: string, configDir: string): Promise<void> {
      const entries = await fetchFor(sessionId);
      if (entries) await seedCredentials(configDir, entries);
    },
  };
}

/** How many times one server may be refreshed within one turn. A provider that
 *  keeps rejecting fresh tokens would otherwise cost a refresh per failed call. */
const MAX_REFRESHES_PER_TURN = 2;

export interface AuthRecoveryDeps {
  /** The live session's MCP server statuses (AgentManager.mcpServerStatus), or
   *  null when the session is not live on this node. */
  status: (sessionId: string) => Promise<Array<{ name: string; status: string }> | null>;
  /** Re-run one server's MCP handshake (AgentManager.reconnectMcpServer). */
  reconnect: (sessionId: string, serverName: string) => Promise<unknown>;
  /** Ask the gateway to refresh one server key for this turn's owner. Returns
   *  the new projection, "reconnect" when the grant is unusable, null when the
   *  gateway knows no such credential. Throws on a transient failure. */
  refresh: (
    tenantId: string,
    jobToken: string,
    serverKey: string,
    failedAccessTokenHash: string,
  ) => Promise<NodeCredential | "reconnect" | null>;
  dirFor: (sessionId: string) => string | null;
  tenantFor: (sessionId: string) => string | undefined;
  tokenFor: (sessionId: string) => string | undefined;
  log?: (message: string) => void;
}

/**
 * Branch R of the Task 1 field note. When a tool call fails, ask the SDK which
 * servers are needs-auth — a closed set of statuses, not an error string — and
 * for each one this session holds a credential for: have the gateway refresh
 * it, rewrite the pod-local file, and reconnect the server. The measured
 * behaviour is that the very next call then uses the new token.
 *
 * The node proves which token failed by its SHA-256, never by the token. The
 * gateway is the one that refreshes; the node cannot, holding no refresh token.
 */
export function makeAuthRecovery(deps: AuthRecoveryDeps) {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const inflight = new Map<string, Promise<void>>();
  /** sessionId → server → refreshes this turn, or Infinity once told to reconnect. */
  const attempts = new Map<string, Map<string, number>>();

  function spent(sessionId: string, server: string): number {
    return attempts.get(sessionId)?.get(server) ?? 0;
  }
  function record(sessionId: string, server: string, n: number) {
    const m = attempts.get(sessionId) ?? new Map<string, number>();
    m.set(server, n);
    attempts.set(sessionId, m);
  }

  async function recover(sessionId: string, server: string): Promise<void> {
    const dir = deps.dirFor(sessionId);
    const tenant = deps.tenantFor(sessionId);
    const token = deps.tokenFor(sessionId);
    if (!dir || !tenant || !token) return;
    const creds = snapshotCredentials(dir);
    const key = Object.keys(creds).find((k) => creds[k]!.serverName === server);
    if (!key) return; // not a credential this session was given

    record(sessionId, server, spent(sessionId, server) + 1);
    const failed = createHash("sha256").update(creds[key]!.accessToken).digest("hex");
    let out: NodeCredential | "reconnect" | null;
    try {
      out = await deps.refresh(tenant, token, key, failed);
    } catch (e) {
      log(`[node] MCP credential refresh failed session=${sessionId} server=${server} ${describeFailure(e)}`);
      return;
    }
    if (out === "reconnect") {
      record(sessionId, server, Infinity);
      log(`[node] MCP server needs reconnecting by its owner session=${sessionId} server=${server}`);
      return;
    }
    if (!out) return;
    // Re-read: another recovery for a different server may have written since.
    const now = snapshotCredentials(dir);
    now[key] = out;
    await seedCredentials(dir, now);
    await deps.reconnect(sessionId, server);
  }

  return {
    /** Call on any failed tool result. Cheap when nothing is needs-auth. */
    async onToolError(sessionId: string): Promise<void> {
      const statuses = await deps.status(sessionId);
      if (!statuses) return;
      const work: Promise<void>[] = [];
      for (const s of statuses) {
        if (s.status !== "needs-auth") continue;
        const flight = `${sessionId}/${s.name}`;
        const running = inflight.get(flight);
        if (running) {
          work.push(running);
          continue;
        }
        if (spent(sessionId, s.name) >= MAX_REFRESHES_PER_TURN) continue;
        const p = recover(sessionId, s.name).finally(() => inflight.delete(flight));
        inflight.set(flight, p);
        work.push(p);
      }
      await Promise.all(work);
    },
    /** A new turn: lift the per-turn refresh limit. */
    resetTurn(sessionId: string): void {
      attempts.delete(sessionId);
    },
  };
}
