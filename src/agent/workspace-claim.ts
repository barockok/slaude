/**
 * The agent's proactive folder: one working directory per agent, shared by
 * every thread a heartbeat `ask`/`act` dispatch opens, so files the agent
 * makes while working a post survive from one post to the next.
 */
import { resolve, dirname, basename } from "node:path";
import { paths } from "../config/home";

const safeId = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, "_");

/** `<paths.workspaces>/agent-<safe id>/proactive`, resolved (absolute, normalised). */
export function proactiveWorkspaceDir(agentId: string): string {
  return resolve(paths.workspaces, `agent-${safeId(agentId)}`, "proactive");
}

/** True exactly for the proactive folder of some agent. */
export function isProactiveWorkspace(dir: string | null | undefined): boolean {
  if (!dir) return false;
  const d = resolve(dir);
  if (basename(d) !== "proactive") return false;
  const agentDir = dirname(d);
  return dirname(agentDir) === resolve(paths.workspaces) && /^agent-[A-Za-z0-9_-]*$/.test(basename(agentDir));
}

/**
 * One holder per folder at a time, in process (mono). A holder is a session
 * id: while it holds the folder, another session's turn there waits; the
 * holder's own next input never waits on itself. Waiters are served in the
 * order they asked. A waiter is only ever delayed, never dropped: releasing
 * a holder that is still waiting leaves its place in the queue alone.
 *
 * On nodes a cross-process lock is taken before a turn reaches the
 * manager, so this claim only ever orders turns that lock already ordered.
 *
 * A folder is keyed by its resolved path, as isProactiveWorkspace reads it,
 * so two spellings of one folder are one folder.
 */
type Waiter = { holder: string; resolve: () => void };

export class WorkspaceClaims {
  #folders = new Map<string, { holder: string; waiters: Waiter[] }>();
  #held = new Map<string, string>();

  /** Resolves once `holder` holds `dir`: at once when free or already its own, else in FIFO turn. */
  acquire(rawDir: string, holder: string): Promise<void> {
    const dir = resolve(rawDir);
    const f = this.#folders.get(dir);
    if (!f) {
      this.#folders.set(dir, { holder, waiters: [] });
      this.#held.set(holder, dir);
      return Promise.resolve();
    }
    if (f.holder === holder) return Promise.resolve();
    return new Promise<void>((resolve) => f.waiters.push({ holder, resolve }));
  }

  /** Free the folder `holder` holds, if any, and hand it to the next waiter. */
  releaseHolder(holder: string): void {
    const dir = this.#held.get(holder);
    if (dir === undefined) return;
    this.#held.delete(holder);
    const f = this.#folders.get(dir)!;
    const next = f.waiters.shift();
    if (!next) {
      this.#folders.delete(dir);
      return;
    }
    // Every waiting input of the next holder goes with it: it holds the folder now.
    const own = f.waiters.filter((w) => w.holder === next.holder);
    f.waiters = f.waiters.filter((w) => w.holder !== next.holder);
    f.holder = next.holder;
    this.#held.set(next.holder, dir);
    next.resolve();
    for (const w of own) w.resolve();
  }

  /** Who holds `dir` now, or null. */
  holderOf(dir: string): string | null {
    return this.#folders.get(resolve(dir))?.holder ?? null;
  }
}
