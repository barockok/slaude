/**
 * Mono remote mode: the query runs in the gateway process, so the target is
 * resolved from the database and the helper is opened here. In split deploys
 * the node does this from the job token's claims (src/node/remote.ts).
 */
import * as Sessions from "../db/sessions";
import { activeRemoteTarget, boundEnv } from "./active";
import { connectInfoForBinding } from "./env-runtime";
import { HelperClient } from "./helper-client";
import { cleanupCommand } from "./tools/bash";
import type { RemoteHandle, RemoteTarget } from "./types";

type HelperOpts = ConstructorParameters<typeof HelperClient>[0];

async function threadOf(sessionId: string): Promise<{ channel: string; thread: string } | null> {
  const row = await Sessions.findById(sessionId);
  return row?.slack_channel_id && row.slack_thread_ts ? { channel: row.slack_channel_id, thread: row.slack_thread_ts } : null;
}

export async function monoRemoteResolver(sessionId: string): Promise<RemoteTarget | null> {
  const t = await threadOf(sessionId);
  return t ? activeRemoteTarget(t.channel, t.thread) : null;
}

/** Opens the helper for the environment the session booted for. Refuses if
 *  the thread has moved to another environment meanwhile, so a stale target
 *  never connects. A sandbox that is not running yet is started here. */
export function makeMonoRemoteFactory(
  newHelper: (opts: HelperOpts) => RemoteHandle = (opts) => new HelperClient(opts),
): (sessionId: string, t: RemoteTarget) => Promise<RemoteHandle> {
  return async (sessionId, t) => {
    const th = await threadOf(sessionId);
    const b = th ? await boundEnv(th.channel, th.thread) : null;
    if (!b || (t.env && b.env.id !== t.env.id)) throw new Error("the thread's environment changed");
    const info = await connectInfoForBinding(b.binding, b.env, { provision: true });
    return newHelper({
      transport: info.transport,
      privateKey: info.privateKey,
      onDispose: async (exec) => { await exec(cleanupCommand(sessionId), { timeoutMs: 30_000 }); },
    });
  };
}
