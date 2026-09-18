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
import { randomBytes } from "node:crypto";
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
