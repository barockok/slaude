import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

export const SLAUDE_HOME = process.env.SLAUDE_HOME || join(homedir(), ".slaude");

/**
 * Default db file under SLAUDE_HOME, overridable via `SLAUDE_DB_PATH`. Use
 * the override when the runtime mounts SLAUDE_HOME from a read-only image
 * layer and persistent state must live on a separately-mounted volume
 * (e.g. k8s PVC subPath). The override accepts either an absolute path or
 * a path resolved against SLAUDE_HOME.
 */
// Resolve an env override that may be absolute or relative-to-SLAUDE_HOME.
const underHome = (v: string | undefined, fallback: string) =>
  v ? (v.startsWith("/") ? v : join(SLAUDE_HOME, v)) : fallback;

const dbPath = underHome(process.env.SLAUDE_DB_PATH, join(SLAUDE_HOME, "db.sqlite"));
// Per-session cwd root, overridable via SLAUDE_WORKSPACES. The sim redirects db +
// workspaces under $SLAUDE_HOME/sim/ so it shares config but never mutates prod state.
const workspacesPath = underHome(process.env.SLAUDE_WORKSPACES, join(SLAUDE_HOME, "workspaces"));

export const paths = {
  home: SLAUDE_HOME,
  soul: join(SLAUDE_HOME, "SOUL.md"),
  skills: join(SLAUDE_HOME, "skills"),
  config: join(SLAUDE_HOME, "config.yaml"),
  env: join(SLAUDE_HOME, ".env"),
  db: dbPath,
  workspaces: workspacesPath,
  knowledge: join(SLAUDE_HOME, "knowledge"),
  claudeConfig: join(SLAUDE_HOME, ".claude"),
} as const;

export function ensureHome() {
  for (const dir of [
    paths.home,
    paths.skills,
    paths.workspaces,
    paths.knowledge,
    dirname(paths.db),
  ]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}
