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

/** A session's Slack thread and persona (mono reads its session row). */
export interface MonoThread {
  channel: string;
  threadTs: string;
  personaId: string | null;
}

/** Turn a `stillAllowed` answer (false or a throw) into VoiceAuthLost. */
async function requireAllowed(stillAllowed: () => Promise<boolean>): Promise<void> {
  let ok = false;
  try {
    ok = await stillAllowed();
  } catch (e) {
    console.error(`[voice] identity check failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!ok) throw new VoiceAuthLost("the thread no longer runs as the agent");
}

export function makeMonoVoiceHost(o: {
  agent: MonoAgent;
  config(): VoiceConfig | null;
  findThread(sessionId: string): Promise<MonoThread | null>;
  remoteTarget(channel: string, threadTs: string): Promise<unknown | null>;
  workingDir(sessionId: string): Promise<string>;
  /** The thread persona's soul (channel mandate applied); null = it cannot be
   *  resolved (a retired persona), and voice is unavailable. */
  soul(t: MonoThread): unknown | null;
}): VoiceHost {
  const refusal: VoiceHost["refusal"] = async (sid) => {
    const t = await o.findThread(sid);
    // A live /1on1 lock or a cron job's captured initiator: runs as a person.
    if (await o.agent.resolveEffectiveIdentity(sid, t?.channel, t?.threadTs)) return "VOICE_AGENT_ONLY";
    // Without the thread the lock and remote target cannot be checked: fail closed.
    if (!t) return "VOICE_UNAVAILABLE";
    if (await o.remoteTarget(t.channel, t.threadTs)) return "VOICE_AGENT_ONLY";
    if (o.soul(t) == null) return "VOICE_UNAVAILABLE";
    return null;
  };
  const stillAllowed = async (sid: string) => (await refusal(sid)) === null;
  // The check runs in the runner after its in-flight wait, right before the
  // turn is sent (see monoRunner).
  const runner = monoRunner(o.agent, { check: (sid) => requireAllowed(() => stillAllowed(sid)) });
  return {
    config: async () => o.config(),
    refusal,
    stillAllowed,
    runner: () => runner,
    transcriptDir: (sid) => o.workingDir(sid),
    spawn: (s) => spawnVoiceLoop(s),
    holdIdle: (sid, h) => o.agent.holdIdle(sid, h),
    instructions: async (sid, brief) => {
      const t = await o.findThread(sid);
      const soul = t ? o.soul(t) : null;
      if (soul == null) throw new Error("the thread's persona soul cannot be resolved");
      return instructionsFrom(soul, brief);
    },
  };
}

export function makeNodeVoiceHost(o: {
  agent: TurnAgent & { holdIdle(id: string, hold: boolean): boolean };
  /** The job token bound to the session for its current turn. */
  tokenFor(id: string): string | undefined;
  /** A token's claims (unverified decode; the gateway verifies on refresh). */
  claims(token: string): (JobClaimsExcerpt & { job?: unknown }) | null;
  bindToken(id: string, token: string): void;
  /** Token refresh; `identity` is the thread's identity as of now. */
  refresh(jobId: string, token: string): Promise<{ jobToken: string; identity?: unknown }>;
  lock<T>(id: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T | typeof HELD_BY_OTHER>;
  bundle(id: string): Promise<{ voice?: VoiceBundle | null; soulJson: unknown } | null>;
  workingDir(id: string): Promise<string>;
  draining(): boolean;
}): VoiceHost {
  /** The exact token whose claims passed voice_start's check, per session.
   *  Data only: the chain (keeper) is started from it in runner(). */
  const checked = new Map<string, { jobId: string; token: string }>();
  const chains = new Map<string, ReturnType<typeof makeTokenKeeper>>();
  const allow = (identity: unknown) =>
    voiceRefusalFromClaims(identity && typeof identity === "object" ? (identity as JobClaimsExcerpt) : null) === null;
  return {
    config: async (sid) => voiceConfigFromBundle((await o.bundle(sid))?.voice),
    refusal: async (sid) => {
      checked.delete(sid);
      if (o.draining()) return "VOICE_UNAVAILABLE";
      const token = o.tokenFor(sid);
      const c = token ? o.claims(token) : null;
      const r = voiceRefusalFromClaims(c);
      if (r) return r;
      if (!token || typeof c?.job !== "string") return "VOICE_UNAVAILABLE";
      checked.set(sid, { jobId: c.job, token });
      return null;
    },
    // The node's identity check is the refresh itself (makeTokenKeeper): this
    // reports what the last one found.
    stillAllowed: async (sid) => chains.get(sid)?.allowed() ?? false,
    // voice_start asks for the runner only after config() succeeded, so the
    // chain starts here, once per call, from the token checked at the start —
    // never from a newer job claimed for the session since.
    runner: (sid) => {
      const start = checked.get(sid);
      checked.delete(sid);
      const keeper = start
        ? makeTokenKeeper({ jobId: start.jobId, token: start.token, refresh: o.refresh, allow, bind: (t) => o.bindToken(sid, t) })
        : null;
      if (keeper) chains.set(sid, keeper);
      else chains.delete(sid);
      return nodeRunner({
        agent: o.agent,
        lock: o.lock,
        // Under the session lock, right before the turn: refresh + identity
        // check + bind, so the token the turn uses is the token checked.
        refreshToken: async () => {
          if (!keeper) throw new VoiceAuthLost("no checked job token to run the call's turns with");
          await keeper.refresh();
        },
      });
    },
    transcriptDir: (sid) => o.workingDir(sid),
    spawn: (s) => spawnVoiceLoop(s),
    holdIdle: (sid, h) => {
      if (!h) chains.delete(sid);
      return o.agent.holdIdle(sid, h);
    },
    instructions: async (sid, brief) => instructionsFrom((await o.bundle(sid))?.soulJson, brief),
  };
}

/** A warm-session reboot ends the session's call (spec §6), in both topologies. */
export function endCallsOnSessionExit(agent: { on(ev: "sessionExit", cb: (sid: string) => void): unknown }, calls: VoiceCalls): void {
  agent.on("sessionExit", (sid: string) => void calls.end(sid, "session_rebooted").catch(() => {}));
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
