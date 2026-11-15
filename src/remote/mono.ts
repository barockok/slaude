/**
 * Mono remote mode: the query runs in the gateway process, so the target is
 * resolved from the database and the helper is opened here. In split deploys
 * the node does this from the job token's claims (src/node/remote.ts).
 */
import * as Sessions from "../db/sessions";
import { boundEnv } from "./active";
import { remoteDecision, sharedBindingPresent, type DecisionDeps, type TurnKind } from "./definitions/decision";
import { connectInfoForBinding } from "./env-runtime";
import { HelperClient } from "./helper-client";
import { cleanupCommand } from "./tools/bash";
import { RemoteError, type RemoteHandle, type RemoteTarget } from "./types";

type HelperOpts = ConstructorParameters<typeof HelperClient>[0];

interface SessionThread { channel: string; thread: string; persona: string | undefined; tenant: string }

async function threadOf(sessionId: string): Promise<SessionThread | null> {
  const row = await Sessions.findById(sessionId);
  return row?.slack_channel_id && row.slack_thread_ts
    ? { channel: row.slack_channel_id, thread: row.slack_thread_ts, persona: row.persona_id ?? undefined, tenant: (row as { tenant_id?: string }).tenant_id ?? "default" }
    : null;
}

/** Remote mode off: no target, unless the thread is still bound to a shared machine, which refuses (a session must not fall back to the server). */
export async function monoSharedBindingGuard(sessionId: string): Promise<RemoteTarget | null> {
  const t = await threadOf(sessionId);
  if (t && (await sharedBindingPresent(t.channel, t.thread))) throw new RemoteError("REMOTE_UNREACHABLE", "this thread's environment may not be used by this agent");
  return null;
}

/** Supplies what kind of turn a session is running now (the gateway knows from the route). Absent: not interactive, so a shared environment is refused. */
export type TurnKindOfSession = (sessionId: string) => TurnKind;

/**
 * The session's remote target. A refusal THROWS: a session whose thread is bound
 * to a shared environment it may not use must fail, never boot with local tools.
 */
export async function monoRemoteResolver(sessionId: string, turnKind: TurnKindOfSession = () => "other", deps?: DecisionDeps): Promise<RemoteTarget | null> {
  const t = await threadOf(sessionId);
  if (!t) return null;
  const d = await remoteDecision({ tenant: t.tenant, persona: t.persona, channel: t.channel, thread: t.thread, turnKind: turnKind(sessionId) }, deps);
  if ("refused" in d) throw new RemoteError("REMOTE_UNREACHABLE", "this thread's environment may not be used by this agent");
  return "target" in d ? d.target : null;
}

/** Opens the helper for the environment the session booted for. Refuses if
 *  the thread has moved to another environment meanwhile, so a stale target
 *  never connects. A sandbox that is not running yet is started here. */
export function makeMonoRemoteFactory(
  newHelper: (opts: HelperOpts) => RemoteHandle = (opts) => new HelperClient(opts),
  turnKind: TurnKindOfSession = () => "other",
  deps?: DecisionDeps,
): (sessionId: string, t: RemoteTarget) => Promise<RemoteHandle> {
  return async (sessionId, t) => {
    const th = await threadOf(sessionId);
    const b = th ? await boundEnv(th.channel, th.thread) : null;
    if (!b || (t.env && b.env.id !== t.env.id)) throw new Error("the thread's environment changed");
    const shared = b.env.source === "definition";
    // Asked again here, and on every exec below: a session that outlives a sync (the allow entry dropped, the row retired) stops at once.
    const recheck = async () => {
      if (!shared || !th) return;
      const d = await remoteDecision({ tenant: th.tenant, persona: th.persona, channel: th.channel, thread: th.thread, turnKind: turnKind(sessionId) }, deps);
      if (!("target" in d) || d.target.env?.id !== b.env.id) throw new RemoteError("REMOTE_UNREACHABLE", "this thread's environment may not be used by this agent");
    };
    await recheck();
    const info = await connectInfoForBinding(b.binding, b.env, { provision: true });
    const handle = newHelper({
      transport: info.transport,
      privateKey: info.privateKey,
      onDispose: async (exec) => { await exec(cleanupCommand(sessionId), { timeoutMs: 30_000 }); },
    });
    if (!shared) return handle;
    return { release: () => handle.release(), dispose: () => handle.dispose(), exec: async (cmd, o) => { await recheck(); return handle.exec(cmd, o); } };
  };
}
