import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

export const SLAUDE_HOME = process.env.SLAUDE_HOME || join(homedir(), ".slaude");

export const paths = {
  home: SLAUDE_HOME,
  soul: join(SLAUDE_HOME, "SOUL.md"),
  skills: join(SLAUDE_HOME, "skills"),
  config: join(SLAUDE_HOME, "config.yaml"),
  env: join(SLAUDE_HOME, ".env"),
  db: join(SLAUDE_HOME, "db.sqlite"),
  workspaces: join(SLAUDE_HOME, "workspaces"),
  knowledge: join(SLAUDE_HOME, "knowledge"),
  claudeConfig: join(SLAUDE_HOME, ".claude"),
} as const;

export function ensureHome() {
  for (const dir of [paths.home, paths.skills, paths.workspaces, paths.knowledge]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}
