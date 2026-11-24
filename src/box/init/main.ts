/**
 * box-init: the first process of every box (box spec, "Credential and egress
 * model").
 *
 * A box has no network, only a loopback interface and two Unix sockets in
 * /run/slaude that the node worker listens on. Proxy variables cannot name a
 * Unix socket, so this program relays two loopback ports to them:
 *
 *   127.0.0.1:3128  ->  /run/slaude/egress.sock   (the session's egress proxy)
 *   127.0.0.1:3129  ->  /run/slaude/llm.sock      (the provider proxy)
 *
 * It makes no decision and holds nothing: every byte is passed on as it came.
 * A compromised box-init gains nothing the agent did not already have.
 *
 * Two modes:
 *
 *   box-init                    Under gVisor: PID 1 of the sandbox. Relays
 *                               until it is killed. Children that are handed
 *                               to it are reaped by the kernel (SIGCHLD is
 *                               set to ignore).
 *   box-init run -- <argv...>   Under bwrap: start the relays, run one command
 *                               with this process's stdio, exit with its
 *                               status. The surrounding pid namespace ends
 *                               everything else when this exits.
 *
 * Built with `bun build --compile` (see the Dockerfile) and bind mounted
 * read-only into every box. It imports nothing from this repository, on
 * purpose: nothing of the node's code or configuration is in the binary's
 * reach.
 */
import { spawn } from "node:child_process";
import { connect, createServer, type Server } from "node:net";

const EGRESS_PORT = 3128;
const PROVIDER_PORT = 3129;
const RUN_DIR = process.env.SLAUDE_BOX_RUN_DIR || "/run/slaude";

function relay(port: number, socketPath: string): Promise<Server> {
  const server = createServer((client) => {
    const upstream = connect(socketPath);
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", end);
    upstream.on("error", end);
    client.on("close", end);
    upstream.on("close", end);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

/** Ask the kernel to reap children nobody waits for. Best effort: a box works without it, with zombies. */
async function ignoreSigchld(): Promise<void> {
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const libc = dlopen("libc.so.6", { signal: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.ptr } });
    const SIGCHLD = 17;
    // SIG_IGN is the pointer value 1.
    libc.symbols.signal(SIGCHLD, 1 as never);
  } catch {
    /* no libc by that name, or no FFI on this platform */
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args[0] === "run" ? "run" : "serve";
  await Promise.all([relay(EGRESS_PORT, `${RUN_DIR}/egress.sock`), relay(PROVIDER_PORT, `${RUN_DIR}/llm.sock`)]);

  if (mode === "serve") {
    await ignoreSigchld();
    // Ended by the sandbox being stopped, never by a signal handler of its own.
    process.on("SIGTERM", () => process.exit(0));
    return;
  }

  const sep = args.indexOf("--");
  const argv = sep >= 0 ? args.slice(sep + 1) : args.slice(1);
  if (argv.length === 0) {
    process.stderr.write("box-init run: no command\n");
    process.exit(64);
  }
  const child = spawn(argv[0]!, argv.slice(1), { stdio: "inherit" });
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
  child.on("error", (e) => {
    process.stderr.write(`box-init run: ${e.message}\n`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 + 15 : 1)));
}

main().catch((e) => {
  process.stderr.write(`box-init: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(70);
});
