/**
 * Gateway-side environment runtime: how a bound environment is reached
 * (connect info for the helper), sandbox provisioning and teardown, cleanup when
 * remote mode ends, and the idle sweep (environments spec §6–§7). Runs only
 * where the database and the master key are: the gateway, or mono.
 */
import * as Envs from "../db/environments";
import * as Remote from "../db/remote";
import { boundEnv } from "./active";
import { getKind, trustOf, type StoredEnv } from "./kinds";
import { remoteCleanup } from "./preflight";
import type { ConnectInfo } from "./transport";
import { RemoteError } from "./types";

/** How to reach a user-machine environment with its owner's key. Throws a
 *  RemoteError the user can act on. */
export async function userMachineConnectInfo(env: StoredEnv): Promise<ConnectInfo> {
  const kind = getKind(env.kind);
  if (!kind?.transport) throw new RemoteError("REMOTE_UNREACHABLE", `environment kind ${env.kind} is not available on this deployment`);
  const key = await Remote.getKey(env.teamId, env.userId);
  if (!key) throw new RemoteError("REMOTE_AUTH_FAILED", "no slaude key for the environment's owner (run /env key)");
  let transport;
  try {
    transport = await kind.transport(env);
  } catch (e) {
    throw new RemoteError("REMOTE_UNREACHABLE", (e as Error).message);
  }
  return { transport, privateKey: key.privateKey };
}

/** How to reach a bound environment now. A provisioned sandbox that is not
 *  provisioned yet is created first when `provision` is set (mono, /env use);
 *  otherwise that is REMOTE_PROVISION_FAILED (fail closed). */
export async function connectInfoForBinding(
  binding: Envs.BindingRow,
  env: StoredEnv,
  opts: { provision?: boolean } = {},
): Promise<ConnectInfo> {
  const kind = getKind(env.kind);
  if (!kind) throw new RemoteError("REMOTE_UNREACHABLE", `environment kind ${env.kind} is not available on this deployment`);
  if (kind.trust !== "provisioned") return userMachineConnectInfo(env);
  let ep = Envs.readEndpoint(binding);
  if (!ep && opts.provision) {
    await ensureProvisioned(binding.channel_id, binding.thread_ts);
    const fresh = await Envs.findBinding(binding.channel_id, binding.thread_ts);
    ep = fresh && fresh.env_id === env.id ? Envs.readEndpoint(fresh) : null;
  }
  if (!ep) throw new RemoteError("REMOTE_PROVISION_FAILED", "the sandbox for this thread is not running; send another message to start it");
  return { transport: ep.transport, privateKey: ep.privateKey };
}

const PROVISION_WAIT_MS = 120_000;

/**
 * Make sure a thread bound to a provisioned environment has a running sandbox.
 * One caller wins the provision (a compare-and-set on the binding's generation);
 * the others wait for its endpoint. A no-op for user-machine environments and
 * unbound threads. Throws REMOTE_PROVISION_FAILED (the binding is left without
 * an endpoint, so the next message tries again).
 */
export async function ensureProvisioned(channelId: string, threadTs: string, waitMs = PROVISION_WAIT_MS): Promise<void> {
  const b = await boundEnv(channelId, threadTs);
  if (!b) return;
  const kind = getKind(b.env.kind)!;
  if (kind.trust !== "provisioned" || !kind.provision) return;
  if (b.binding.endpoint) {
    await Envs.touchBinding(channelId, threadTs);
    return;
  }
  const gen = Number(b.binding.generation);
  if (await Envs.claimProvision(channelId, threadTs, gen)) {
    let ep;
    try {
      ep = await kind.provision(b.env, bindingKey(channelId, threadTs));
    } catch (e) {
      console.error(`[env] provision failed kind=${b.env.kind}: ${(e as Error).message}`);
      throw new RemoteError("REMOTE_PROVISION_FAILED", "could not start the sandbox");
    }
    if (!(await Envs.storeEndpoint(channelId, threadTs, gen + 1, ep))) {
      // Unbound or rebound while provisioning: nobody will use this sandbox.
      await kind.teardown!(b.env, ep, bindingKey(channelId, threadTs)).catch(() => {});
      throw new RemoteError("REMOTE_PROVISION_FAILED", "the thread's environment changed while its sandbox was starting");
    }
    return;
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const cur = await Envs.findBinding(channelId, threadTs);
    if (!cur || cur.env_id !== b.env.id) return;
    if (cur.endpoint) return;
  }
  throw new RemoteError("REMOTE_PROVISION_FAILED", "timed out waiting for the sandbox to start");
}

/** Stable per-thread key a provisioner can name its sandbox after. */
export function bindingKey(channelId: string, threadTs: string): string {
  return `${channelId}-${threadTs}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Remote mode ended for a thread whose binding was `removed`: kill the
 *  session's background jobs on a user machine, or tear down a sandbox. Best
 *  effort; never throws; logs codes only. */
export async function releaseBinding(
  removed: Envs.BindingRow,
  opts: { sessionId?: string; cleanup?: typeof remoteCleanup } = {},
): Promise<void> {
  try {
    const env = await Envs.getEnv(removed.env_id);
    if (!env) return;
    const kind = getKind(env.kind);
    if (!kind) return;
    if (kind.trust === "provisioned") {
      const ep = Envs.readEndpoint(removed);
      if (ep) await kind.teardown!(env, ep, bindingKey(removed.channel_id, removed.thread_ts));
      return;
    }
    if (!opts.sessionId) return;
    const info = await userMachineConnectInfo(env);
    await (opts.cleanup ?? remoteCleanup)({ info, sessionKey: opts.sessionId });
  } catch (e) {
    console.error(`[env] release skipped: ${e instanceof RemoteError ? e.code : "error"}`);
  }
}

/** Default idle time before a sandbox is torn down (it restarts on the next message). */
export const SANDBOX_IDLE_TTL_MS = 60 * 60_000;

/**
 * Tear down sandboxes idle longer than `ttlMs`. Safe on every replica at once:
 * each teardown is claimed with a compare-and-set first. `onTornDown` lets mono
 * reboot a warm session (a split deploy notices through the fingerprint, which
 * changes when the sandbox is provisioned again).
 */
export async function sweepIdleSandboxes(
  ttlMs = SANDBOX_IDLE_TTL_MS,
  onTornDown?: (channelId: string, threadTs: string) => void,
): Promise<number> {
  let n = 0;
  for (const b of await Envs.idleProvisioned(Date.now() - ttlMs)) {
    const env = await Envs.getEnv(b.env_id);
    const kind = env ? getKind(env.kind) : undefined;
    if (!env || kind?.trust !== "provisioned") continue;
    if (!(await Envs.claimTeardown(b.channel_id, b.thread_ts, Number(b.generation)))) continue;
    const ep = Envs.readEndpoint(b);
    if (ep) await kind.teardown!(env, ep, bindingKey(b.channel_id, b.thread_ts)).catch((e) => console.error(`[env] idle teardown failed: ${(e as Error).message}`));
    n++;
    onTornDown?.(b.channel_id, b.thread_ts);
  }
  return n;
}

export { trustOf };
