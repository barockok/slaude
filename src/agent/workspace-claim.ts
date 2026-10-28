/**
 * The agent's proactive folder: one working directory per agent, shared by
 * every thread a heartbeat `ask`/`act` dispatch opens, so files the agent
 * makes while working a post survive from one post to the next.
 */
import { join, resolve, dirname, basename } from "node:path";
import { paths } from "../config/home";

const safeId = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, "_");

/** `<paths.workspaces>/agent-<safe id>/proactive`. */
export function proactiveWorkspaceDir(agentId: string): string {
  return join(paths.workspaces, `agent-${safeId(agentId)}`, "proactive");
}

/** True exactly for the proactive folder of some agent. */
export function isProactiveWorkspace(dir: string | null | undefined): boolean {
  if (!dir) return false;
  const d = resolve(dir);
  if (basename(d) !== "proactive") return false;
  const agentDir = dirname(d);
  return dirname(agentDir) === resolve(paths.workspaces) && /^agent-[A-Za-z0-9_-]*$/.test(basename(agentDir));
}
