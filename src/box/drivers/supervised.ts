/**
 * A sandbox driver over the box supervisor: the part the gVisor and the bwrap
 * tiers share, which is everything except the tier's name. The supervisor
 * (src/box/boxd/) knows how each tier is made; this is the node worker's side.
 *
 * One sandbox, in order:
 *
 *   start   refuse a config directory that holds a credentials file; make the
 *           session's run directory; start its egress proxy and its provider
 *           proxy on two sockets there; ask the supervisor for the sandbox.
 *           Any failure stops what was started and is a BootFailure: it never
 *           becomes an unboxed run.
 *   spawn   the Agent SDK's spawn hook. The command must be the CLI the node
 *           ships (bind mounted at its own path); the environment is built
 *           from nothing by buildBoxEnv; the process runs inside through the
 *           supervisor and its stdio is the only channel back.
 *   stop    the supervisor ends every process and throws the root overlay
 *           away; then the proxies stop. Home and workspace stay.
 *
 * No credential is given to the supervisor or to the box: the provider's real
 * credential is read per request inside the provider proxy, which runs in
 * this process.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BootFailure } from "../../gateway/core/failure-codes";
import type { BoxdClient, BoxProcess } from "../boxd/client";
import { BoxdError, type SandboxTier } from "../boxd/protocol";
import { startProviderProxy, type ProviderCredential, type ProviderProxy } from "../egress/llm";
import { startEgressProxy, type EgressProxy, type EgressRefusal } from "../egress/proxy";
import { buildBoxEnv, type ProviderForm } from "../env";
import type { BoxEgress } from "../policy";
import { boxSessionSegment } from "../resolver";
import type { BoxSpec, SandboxDriver, SandboxProbe, SandboxStats, SandboxStopReason, SessionSandbox, SpawnOptions, SpawnedProcess } from "../sandbox";

/** How a session reaches its model provider: where, and with which credential. Never sent to the supervisor. */
export interface ProviderRoute {
  baseUrl: string;
  form: ProviderForm;
  credential: string;
}

export interface SupervisedDriverDeps {
  client: BoxdClient;
  /** SLAUDE_BOX_DIR. */
  boxDir: string;
  /** The session's egress rules, read on every connection. */
  egressRules: (sessionId: string) => Promise<BoxEgress> | BoxEgress;
  /** The session's provider route, read on every model request (a rotation needs no restart). */
  provider: (sessionId: string) => Promise<ProviderRoute> | ProviderRoute;
  /** Host names a box never reaches, whatever its rules: the gateway, Redis, the object store. */
  refuseHosts?: readonly string[];
  /** The commands a spawn may name: the CLI binary the SDK starts. Anything else is refused. */
  allowedCommands: () => readonly string[];
  onEgressRefuse?: (sessionId: string, e: { host: string; port: number; reason: EgressRefusal }) => void;
  log?: (line: string) => void;
}

const unavailable = (why: string, cause?: unknown): BootFailure => new BootFailure("BOX_UNAVAILABLE", why, cause === undefined ? {} : { cause });

/** A config directory that carries a credential store cannot be given to a box. */
export const CONFIG_CREDENTIAL_FILES: readonly string[] = [".credentials.json"];

export interface SupervisedDriver extends SandboxDriver {
  /** End the open connections of a session that its current rules refuse (after a reload). */
  closeDisallowed(sessionId: string): Promise<number>;
  /** Sessions whose sandbox this driver started and has not stopped. */
  sessions(): string[];
}

export function makeSupervisedDriver(tier: SandboxTier, deps: SupervisedDriverDeps): SupervisedDriver {
  const log = deps.log ?? ((l: string) => console.log(l));
  const egressOf = new Map<string, EgressProxy>();

  function create(spec: BoxSpec): SessionSandbox {
    const sandboxId = boxSessionSegment(spec.sessionId);
    const runDir = join(deps.boxDir, "sessions", sandboxId, "run");
    let egress: EgressProxy | null = null;
    let llm: ProviderProxy | null = null;
    let started = false;
    let form: ProviderForm | null = null;
    let imageEnv: Record<string, string> = {};
    const procs = new Set<BoxProcess>();

    async function closeProxies(): Promise<void> {
      egressOf.delete(spec.sessionId);
      await egress?.close().catch(() => {});
      await llm?.close().catch(() => {});
      egress = null;
      llm = null;
      rmSync(runDir, { recursive: true, force: true });
    }

    return {
      tier,

      async start() {
        if (started) return;
        if (spec.configDir) {
          for (const name of CONFIG_CREDENTIAL_FILES) {
            if (existsSync(join(spec.configDir, name))) throw unavailable(`the session's config directory holds ${name}: a box is never given a credential store`);
          }
        }
        // A Unix socket path holds about 107 bytes; past that the proxies could not listen, with an error that says little.
        if (Buffer.byteLength(join(runDir, "egress.sock")) > 104) {
          throw unavailable("SLAUDE_BOX_DIR is too long: a session's proxy sockets under it would not fit a Unix socket path (about 100 bytes)");
        }
        try {
          const route = await deps.provider(spec.sessionId);
          form = route.form;
          mkdirSync(runDir, { recursive: true, mode: 0o755 });
          egress = await startEgressProxy({
            socketPath: join(runDir, "egress.sock"),
            rules: () => deps.egressRules(spec.sessionId),
            ...(deps.refuseHosts ? { refuseHosts: deps.refuseHosts } : {}),
            onRefuse: (e) => deps.onEgressRefuse?.(spec.sessionId, e),
          });
          egressOf.set(spec.sessionId, egress);
          llm = await startProviderProxy({
            socketPath: join(runDir, "llm.sock"),
            upstream: async () => (await deps.provider(spec.sessionId)).baseUrl,
            credential: async (): Promise<ProviderCredential> => {
              const r = await deps.provider(spec.sessionId);
              return { form: r.form, value: r.credential };
            },
          });
          const r = spec.policy.resources;
          const res = await deps.client.request("sandbox.create", {
            sandboxId,
            tier,
            digest: spec.digest,
            mounts: spec.mounts,
            runDir,
            cwd: spec.cwd,
            resources: { cpu: r.cpu, memoryMb: r.memoryMb, pids: r.pids, rootOverlayMb: r.rootOverlayMb },
          });
          imageEnv = res.imageEnv ?? {};
          started = true;
        } catch (e) {
          await closeProxies();
          // The supervisor's messages name paths and steps, never a credential (it holds none).
          const why = e instanceof Error ? e.message : String(e);
          log(`[box] the sandbox of session=${spec.sessionId} did not start: ${why}`);
          if (e instanceof BootFailure) throw e;
          throw unavailable(`the sandbox did not start: ${why}`, e);
        }
      },

      spawn(o: SpawnOptions): SpawnedProcess {
        if (!started || !form) throw unavailable("the sandbox is not started");
        if (!deps.allowedCommands().includes(o.command)) throw unavailable("a box runs the agent's CLI and nothing else from the node");
        const configDir = spec.configDir ?? o.env.CLAUDE_CONFIG_DIR;
        if (!configDir || (o.env.CLAUDE_CONFIG_DIR && o.env.CLAUDE_CONFIG_DIR !== configDir)) throw unavailable("the session's config directory is not the one its sandbox was started with");
        const env = buildBoxEnv({ sdkEnv: o.env, imageEnv, policy: spec.policy, scratchDir: spec.scratchDir ?? "/tmp", configDir, providerForm: form });
        const proc = deps.client.exec({ sandboxId, argv: [o.command, ...o.args], env, cwd: o.cwd ?? spec.cwd });
        procs.add(proc);
        proc.once("exit", () => procs.delete(proc));
        // The SDK aborts this signal after its own grace period: by then the process must go.
        const onAbort = () => proc.kill("SIGTERM");
        if (o.signal.aborted) onAbort();
        else o.signal.addEventListener("abort", onAbort, { once: true });
        return proc as unknown as SpawnedProcess;
      },

      async stats(): Promise<SandboxStats> {
        return deps.client.request("sandbox.stats", { sandboxId });
      },

      async stop(reason: SandboxStopReason) {
        if (!started && !egress && !llm) return;
        started = false;
        for (const p of procs) p.kill("SIGKILL");
        procs.clear();
        try {
          await deps.client.request("sandbox.stop", { sandboxId });
        } catch (e) {
          // A supervisor that is gone took its sandboxes with it; anything else is worth a line.
          if (!(e instanceof BoxdError && e.code === "unavailable")) log(`[box] stopping the sandbox of session=${spec.sessionId} (${reason}) failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          await closeProxies();
        }
      },
    };
  }

  return {
    tier,
    async probe(): Promise<SandboxProbe> {
      try {
        const p = await deps.client.request("probe", {}, { timeoutMs: 20_000 });
        const t = p.tiers[tier];
        return t.ok ? { ok: true } : { ok: false, reason: t.reason ?? `the supervisor cannot run tier ${tier}` };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },
    create,
    closeDisallowed: async (sessionId) => (await egressOf.get(sessionId)?.closeDisallowed()) ?? 0,
    sessions: () => [...egressOf.keys()],
  };
}
