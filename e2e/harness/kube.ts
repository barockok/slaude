// Process-spawning kubectl helpers for the e2e cluster harness.
//
// NOT imported by any *.test.ts: spawning kubectl needs a live cluster, and loading this file
// from a test would count its uncovered lines against the repo-wide coverage threshold. Only
// *.e2e.ts files and scripts import it; the pure logic lives in ./kube-args.ts (unit tested).
//
// Every call targets profile/context slaude-e2e (override: SLAUDE_LOCAL_PROFILE), namespace
// slaude-scale. The user's slaude-local profile is never touched.
import { createConnection, createServer } from "node:net";
import { buildKubectlArgs, containerId, forwardedPort, parsePods, profileName, type Component } from "./kube-args";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}
export interface RunOpts {
  input?: string;
  timeoutMs?: number;
}

async function run(cmd: string[], opts: RunOpts = {}): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    stdin: opts.input === undefined ? "ignore" : new TextEncoder().encode(opts.input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = opts.timeoutMs ? setTimeout(() => proc.kill(), opts.timeoutMs) : undefined;
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (timer) clearTimeout(timer);
  return { stdout, stderr, code };
}

export const kubectl = (args: string[], opts?: RunOpts) => run(["kubectl", ...buildKubectlArgs(args)], opts);

async function podsOf(component: Component) {
  const r = await kubectl(["get", "pod", "-l", `app.kubernetes.io/component=${component}`, "-o", "json"]);
  if (r.code !== 0) throw new Error(`kubectl get pod failed: ${r.stderr.trim()}`);
  return parsePods(r.stdout, component);
}

export async function podNames(component: Component): Promise<string[]> {
  return (await podsOf(component)).map((p) => p.name);
}

export async function podIps(component: Component): Promise<Record<string, string>> {
  return Object.fromEntries((await podsOf(component)).map((p) => [p.name, p.ip]));
}

/** `kubectl exec <target> -c <container> -- <cmd>`. `target` is a pod name or `deploy/<name>`. */
export const execIn = (target: string, container: string, cmd: string[], opts?: RunOpts) =>
  kubectl(["exec", target, "-c", container, "--", ...cmd], opts);

export async function copyTo(pod: string, container: string, localPath: string, remotePath: string): Promise<void> {
  const r = await kubectl(["cp", "-c", container, localPath, `${pod}:${remotePath}`]);
  if (r.code !== 0) throw new Error(`kubectl cp failed: ${r.stderr.trim()}`);
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
}

/** Ask the OS for a free ephemeral port (the listener is closed again before it is returned). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Forward a free local port to <target>:<remotePort> and resolve with that port once it is
 * really ours: kubectl printed `Forwarding from ... -> <remotePort>` for the port we picked, the
 * port accepts connections, and the child is still alive after a short settle. A listener that
 * was already on the port cannot pass this, because kubectl would exit with "address in use".
 */
export async function portForward(target: string, remotePort: number, timeoutMs = 15_000): Promise<{ localPort: number; stop(): void }> {
  const localPort = await freePort();
  const proc = Bun.spawn(["kubectl", ...buildKubectlArgs(["port-forward", target, `${localPort}:${remotePort}`])], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stop = () => proc.kill();
  let seen = "";
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    for await (const chunk of stream) seen += dec.decode(chunk);
  };
  // A stream error (the child killed mid-read) must not become an unhandled rejection; the
  // readiness loop below already fails on an exited child.
  void pump(proc.stdout).catch(() => {});
  void pump(proc.stderr).catch(() => {});
  const fail = (why: string): never => {
    stop();
    throw new Error(`port-forward to ${target}: ${why}${seen.trim() ? `: ${seen.trim()}` : ""}`);
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) fail("kubectl exited early");
    if (forwardedPort(seen, remotePort) === localPort && (await canConnect(localPort))) {
      await Bun.sleep(200);
      if (proc.exitCode !== null) fail("kubectl exited right after reporting the forward");
      return { localPort, stop };
    }
    await Bun.sleep(100);
  }
  return fail(`not ready within ${timeoutMs}ms`);
}

/**
 * SIGKILL a container's main process through the container runtime, as `crash` does in
 * deploy/k8s-local/verify-ha.sh: signalling PID 1 from inside the container is ignored by the
 * kernel, so it has to come from the node. Not called by the baseline suite; for the follow-up failover scenarios.
 */
export async function killContainer(pod: string, container: string): Promise<void> {
  const got = await kubectl(["get", "pod", pod, "-o", "json"]);
  if (got.code !== 0) throw new Error(`kubectl get pod ${pod} failed: ${got.stderr.trim()}`);
  const id = containerId(got.stdout, container);
  if (!id) throw new Error(`no containerID for ${pod}/${container}`);
  const r = await run(["minikube", "-p", profileName(), "ssh", "--", "docker", "kill", "--signal=KILL", id]);
  if (r.code !== 0) throw new Error(`docker kill failed: ${r.stderr.trim()}`);
}
