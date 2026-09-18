/**
 * Pod-local config homes for node sessions.
 *
 * On a node, every session's CLAUDE_CONFIG_DIR lives under a root that belongs
 * to the pod alone — an emptyDir in the manifests — never on the shared volume.
 * Two measured reasons:
 *
 * - The agent writes its credentials file with a temp-file rename. A rename
 *   over a symlink replaces the link, so any credentials file shared between
 *   processes is silently un-shared the first time it is written. A file with
 *   exactly one owner makes that rename harmless.
 * - On a node the gateway is the only source of credentials. Nothing on the
 *   shared volume should be able to supply one.
 *
 * Only credentials move. Settings and plugins come from the persona's home and
 * transcripts stay on the shared volume through the projects/ symlink, so a
 * session resumed on any node finds its history.
 *
 * Keyed on the session, not the owner: two sessions running as the agent can
 * run on one node at once, and they must not share a working copy either.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { env } from "../config/env";
import { agentConfigDir, ensurePersonaConfigDir, prepareConfigHome } from "./oauth-home";

const DEFAULT_ROOT = "/config-home";

/** The pod-local root on a node; null in every other role, which keeps today's
 *  config homes unchanged. */
export function nodeConfigRoot(): string | null {
  if (env.role() !== "node") return null;
  return process.env.SLAUDE_NODE_CONFIG_ROOT?.trim() || DEFAULT_ROOT;
}

/** A session id is used as one path segment; refuse anything that is not. */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Create (idempotently) and return the pod-local config home for one session.
 * `persona` is the session's persona name; "default" or absent means the agent's
 * own home is the base for settings, plugins and transcripts.
 */
export function sessionConfigDir(sessionId: string, persona?: string, root: string | null = nodeConfigRoot()): string {
  if (!root) throw new Error("pod-local config homes exist only in the node role");
  if (!SAFE_SEGMENT.test(sessionId) || sessionId === "." || sessionId === "..") {
    throw new Error("refusing a session id that is not a single safe path segment");
  }
  const named = persona && persona !== "default" ? persona : null;
  const base = named ? ensurePersonaConfigDir(named) : agentConfigDir();
  const dir = join(root, "sessions", sessionId);
  prepareConfigHome(dir, base, 0o700);
  return dir;
}

/** The session's pod-local home if it already exists, without creating it. */
export function existingSessionConfigDir(sessionId: string, root: string | null = nodeConfigRoot()): string | null {
  if (!root || !SAFE_SEGMENT.test(sessionId) || sessionId === "." || sessionId === "..") return null;
  const dir = join(root, "sessions", sessionId);
  return existsSync(dir) ? dir : null;
}
