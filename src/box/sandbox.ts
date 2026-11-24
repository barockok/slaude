/**
 * The seam between the agent runtime and a sandbox (box spec, "Sandbox tiers
 * and the SessionSandbox interface").
 *
 * AgentManager asks one resolver for a session's sandbox. A null answer is
 * tier `none`: the CLI is spawned as it always was. A sandbox adds one SDK
 * option, `spawnClaudeCodeProcess`, so the agent process itself runs inside
 * the box and its stdio is the only channel to the node worker. Hooks,
 * permission prompts and in-process MCP servers keep running outside.
 *
 * A failure to resolve or start a sandbox fails the boot. It never becomes an
 * unboxed run.
 */
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { BoxPolicy, BoxTier } from "./policy";

export type { BoxTier } from "./policy";
export type { SpawnOptions, SpawnedProcess };

export interface BoxMount {
  source: string;
  /** Equal to source for the workspace, the config directory and the scratch directory. */
  target: string;
  mode: "ro" | "rw";
}

export interface BoxSpec {
  sessionId: string;
  tenantId: string;
  persona: string;
  /** The pinned image. */
  digest: string;
  /** Limits, env, stdio servers. */
  policy: BoxPolicy;
  /** Home, workspace, config directory, scratch, plugins, the CLI. */
  mounts: BoxMount[];
  cwd: string;
  /** The session's CLAUDE_CONFIG_DIR (one of the mounts). A sandbox start refuses one that holds a credentials file. */
  configDir?: string;
  /** The session's scratch directory (one of the mounts): TMPDIR inside the box. */
  scratchDir?: string;
}

export type SandboxStopReason = "idle" | "pressure" | "evict" | "fenced" | "refresh" | "drain" | "error";

export interface SandboxStats {
  memoryBytes: number;
  pids: number;
  homeBytes: number;
  overlayBytes: number;
}

export interface SessionSandbox {
  readonly tier: BoxTier;
  /** Start the sandbox. Idempotent. */
  start(): Promise<void>;
  /** The Agent SDK's spawnClaudeCodeProcess: run the CLI inside, stdio piped. */
  spawn(o: SpawnOptions): SpawnedProcess;
  /** Memory, process count and disk, for limits, admission and metrics. */
  stats(): Promise<SandboxStats>;
  /** Kill every process and remove the root overlay. Home and workspace stay for the sync. */
  stop(reason: SandboxStopReason): Promise<void>;
}

export type SandboxProbe = { ok: true } | { ok: false; reason: string };

export interface SandboxDriver {
  readonly tier: BoxTier;
  /** Whether this node can run the tier, and why not. Checked once at boot. */
  probe(): Promise<SandboxProbe>;
  create(spec: BoxSpec): SessionSandbox;
}

/**
 * The manager's seam. Null means tier `none` (today's spawn). A throw fails
 * the boot.
 */
export type SandboxResolver = (sessionId: string) => Promise<SessionSandbox | null>;
