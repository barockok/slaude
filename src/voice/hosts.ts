/**
 * VoiceHost implementations: where a call's config, identity check, turn runner
 * and child process come from, per runtime (the mono process or a node worker).
 * Calls run as the agent identity only (voice mode spec §3, §10).
 */
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { AgentManager } from "../agent/manager";
import { buildInstructions, createVoiceMcp, VOICE_MCP_NAME, type VoiceHost } from "../agent/voice-mcp";
import type { HELD_BY_OTHER } from "../queue/locks";
import type { VoiceCalls } from "./call";
import { voiceConfigFromBundle, type VoiceBundle, type VoiceConfig } from "./config";
import { makeTokenKeeper, monoRunner, nodeRunner, VoiceAuthLost, type TurnAgent } from "./runners";
import { spawnVoiceLoop } from "./spawn";

type JobClaimsExcerpt = { lock?: unknown; remote?: unknown; runAs?: string };

/** A job token's claims (or the gateway's fresh thread identity) → the
 *  agent-only refusal: a /1on1 lock, a /remote target, or a turn that runs as
 *  a person. Fails closed: allowed only when the identity is positively the
 *  agent and the lock is positively absent (`lock: null`; a token from an older
 *  gateway has no lock claim at all). */
export function voiceRefusalFromClaims(c: JobClaimsExcerpt | null): "VOICE_AGENT_ONLY" | "VOICE_UNAVAILABLE" | null {
  if (!c) return "VOICE_UNAVAILABLE";
  if (c.lock) return "VOICE_AGENT_ONLY";
  if (c.remote) return "VOICE_AGENT_ONLY";
  if (c.runAs !== undefined && c.runAs !== "agent") return "VOICE_AGENT_ONLY";
  if (c.runAs !== "agent" || !("lock" in c)) return "VOICE_UNAVAILABLE";
  return null;
}

/** The voice model's instructions from a soul (SoulData on mono, the bundle's
 *  soulJson on a node; either may be missing or partial). */
export function instructionsFrom(soul: unknown, brief: string): string {
  const s = (soul && typeof soul === "object" ? soul : {}) as {
    identity?: { name?: string; role?: string; voice?: string };
    values?: unknown;
    mandate?: string;
  };
  const values = Array.isArray(s.values) ? s.values.filter((v): v is string => typeof v === "string") : [];
  return buildInstructions({ ...(s.identity ?? {}), values, mandate: s.mandate }, brief);
}

type MonoAgent = Parameters<typeof monoRunner>[0] & Pick<AgentManager, "holdIdle" | "resolveEffectiveIdentity">;

export function makeMonoVoiceHost(o: {
  agent: MonoAgent;
  config(): VoiceConfig | null;
  findThread(sessionId: string): Promise<{ channel: string; threadTs: string } | null>;
  remoteTarget(channel: string, threadTs: string): Promise<unknown | null>;
  workingDir(sessionId: string): Promise<string>;
  soul(): unknown;
}): VoiceHost {
  const runner = monoRunner(o.agent);
  return {
    config: async () => o.config(),
    refusal: async (sid) => {
      const t = await o.findThread(sid);
      // A live /1on1 lock or a cron job's captured initiator: runs as a person.
      if (await o.agent.resolveEffectiveIdentity(sid, t?.channel, t?.threadTs)) return "VOICE_AGENT_ONLY";
      // Without the thread the lock and remote target cannot be checked: fail closed.
      if (!t) return "VOICE_UNAVAILABLE";
      if (await o.remoteTarget(t.channel, t.threadTs)) return "VOICE_AGENT_ONLY";
      return null;
    },
    runner: () => runner,
    transcriptDir: (sid) => o.workingDir(sid),
    spawn: (s) => spawnVoiceLoop(s),
    holdIdle: (sid, h) => o.agent.holdIdle(sid, h),
    instructions: async (_sid, brief) => instructionsFrom(o.soul(), brief),
  };
}

export function makeNodeVoiceHost(o: {
  agent: TurnAgent & { holdIdle(id: string, hold: boolean): boolean };
  currentJob(id: string): { jobId: string; token: string } | undefined;
  bindToken(id: string, token: string): void;
  refresh(jobId: string, token: string): Promise<string>;
  lock<T>(id: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T | typeof HELD_BY_OTHER>;
  bundle(id: string): Promise<{ voice?: VoiceBundle | null; soulJson: unknown } | null>;
  workingDir(id: string): Promise<string>;
  draining(): boolean;
  /** The session's job-token claims; null when unknown (refused). */
  claims(id: string): JobClaimsExcerpt | null;
}): VoiceHost {
  return {
    config: async (sid) => voiceConfigFromBundle((await o.bundle(sid))?.voice),
    refusal: async (sid) => {
      if (o.draining()) return "VOICE_UNAVAILABLE";
      if (!o.currentJob(sid)) return "VOICE_UNAVAILABLE";
      return voiceRefusalFromClaims(o.claims(sid));
    },
    // voice_start asks for the runner only after config() succeeded, so the
    // token chain starts here, once per call, from the newest claimed job.
    runner: (sid) => {
      const job = o.currentJob(sid);
      const keeper = job && makeTokenKeeper({ jobId: job.jobId, token: job.token, refresh: o.refresh, bind: (t) => o.bindToken(sid, t) });
      return nodeRunner({
        agent: o.agent,
        lock: o.lock,
        refreshToken: async () => {
          if (!keeper) throw new VoiceAuthLost("no job token to run the call's turns with");
          try {
            await keeper.refresh();
          } catch (e) {
            throw new VoiceAuthLost(e instanceof Error ? e.message : String(e));
          }
        },
      });
    },
    transcriptDir: (sid) => o.workingDir(sid),
    spawn: (s) => spawnVoiceLoop(s),
    holdIdle: (sid, h) => o.agent.holdIdle(sid, h),
    instructions: async (sid, brief) => instructionsFrom((await o.bundle(sid))?.soulJson, brief),
  };
}

/** Node drain (spec §8): end every call, but never past the drain grace. */
export async function drainVoiceCalls(calls: VoiceCalls, graceMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    calls.endAll("node_drain").catch((e) => console.error("[voice] drain failed:", e instanceof Error ? e.message : e)),
    new Promise<void>((r) => (timer = setTimeout(r, graceMs))),
  ]);
  clearTimeout(timer);
}

/** The voice server for a session whose host has voice configured; none
 *  otherwise (or when the config cannot be read — the session still boots). */
export async function voiceServersFor(sessionId: string, host: VoiceHost, calls: VoiceCalls): Promise<Record<string, McpServerConfig>> {
  try {
    if (!(await host.config(sessionId))) return {};
  } catch (e) {
    console.warn(`[voice] config unavailable session=${sessionId}: ${e instanceof Error ? e.message : e}`);
    return {};
  }
  return { [VOICE_MCP_NAME]: createVoiceMcp(sessionId, host, calls) };
}
