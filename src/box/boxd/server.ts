/**
 * boxd, the box supervisor (box spec, "Architecture").
 *
 * It is the one privileged process of a node pod and it holds nothing: no
 * credential, no network call. It does only what needs privilege: starting,
 * entering and ending sandboxes, their cgroups, and reading and writing files
 * that belong to a sandbox's user. The node worker decides everything; boxd
 * checks every argument (src/box/boxd/protocol.ts).
 *
 * Per sandbox, under SLAUDE_BOX_DIR/sessions/<id>/:
 *
 *   overlay/   the root overlay's data, created and deleted with the sandbox
 *   bundle/    gVisor: the OCI bundle (config.json)
 *   root/      bwrap: where the overlay root is mounted
 *
 * The session's home and run directories are in the same place, but they are
 * named by the worker as mounts and outlive the sandbox.
 *
 * Two backends behind one contract:
 *
 *   gvisor  a detached runsc sandbox with box-init as its first process; each
 *           process the worker starts is `runsc exec --new-pidns`, ended with
 *           `runsc kill --pid` (killing the exec client does not end it);
 *   bwrap   no long-lived process: an overlay mount and a cgroup; each process
 *           is its own `bwrap` on them, ended by ending bwrap.
 *
 * A sandbox belongs to the control connection that created or last used it.
 * When that connection goes away its sandboxes are stopped after a grace
 * period (a restarted worker has lost their stdio anyway). When boxd itself
 * starts, everything a previous boxd left is ended.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, chownSync, closeSync, existsSync, lchownSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, rmdirSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { makeImageStore, cliImageRunner, type ImageStore } from "../image";
import {
  BOXD_PROTOCOL_VERSION,
  BoxdError,
  FRAME,
  checkAbsolute,
  checkArgv,
  checkDigest,
  checkEnv,
  checkMounts,
  checkResources,
  checkSandboxId,
  checkSignal,
  checkTier,
  encodeFrame,
  frameDecoder,
  makePathPolicy,
  parseRequest,
  type BoxdResponse,
  type PathPolicy,
  type ProbeResult,
  type ProtocolMount,
  type SandboxCreateParams,
  type SandboxTier,
  type TierProbe,
} from "./protocol";
import { bwrapArgs, cgroupName, ociConfig, runscExecArgs, runscGlobalArgs, runscRunArgs } from "./spec";
import { seccompProgram } from "./seccomp";

export interface BoxdConfig {
  boxDir: string;
  socketPath: string;
  mountRoots: string[];
  roRoots: string[];
  /** A directory on boxd's side that holds `box-init` and nothing else. */
  initDir: string;
  /** The uid and gid of the agent user inside every box. */
  agentUid: number;
  /** The tier of this node: who owns the files pack requests write. */
  tier: SandboxTier;
  /** The worker's uid and gid, when it is not boxd's own: the control and stdio sockets are given to it. */
  clientUid?: number;
  clientGid?: number;
  /** How long a sandbox outlives the connection that owned it. Default 30 s. */
  ownerGraceMs?: number;
  /** The root of the cgroup tree boxd may create children in. Default /sys/fs/cgroup. */
  cgroupRoot?: string;
  runsc?: string;
  bwrap?: string;
  log?: (line: string) => void;
}

/** One sandbox as a backend sees it. */
export interface SandboxRecord {
  id: string;
  tier: SandboxTier;
  digest: string;
  rootfs: string;
  dir: string;
  overlayDir: string;
  runDir: string;
  mounts: ProtocolMount[];
  cwd: string;
  resources: SandboxCreateParams["resources"];
  uid: number;
  gid: number;
  startedAt: number;
}

export interface ExecRequest {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  /** A place for the backend's own per-process file (a pid file). */
  scratch: string;
}

/** What a tier needs to provide. The supervisor does everything else. */
export interface SandboxBackend {
  readonly tier: SandboxTier;
  /** Who owns a box's files on the node's disk. */
  readonly hostOwner: { uid: number; gid: number };
  probe(): TierProbe;
  /** End what an earlier supervisor left behind. */
  sweep(): void;
  start(sb: SandboxRecord): Promise<void>;
  /** Start one process with piped stdio. */
  exec(sb: SandboxRecord, req: ExecRequest): ChildProcess;
  /** Send a signal to a process started by `exec` and everything it started. */
  signal(sb: SandboxRecord, req: ExecRequest, child: ChildProcess, signal: string): void;
  stop(sb: SandboxRecord): Promise<void>;
  /** The sandbox's cgroup directory, or null when it has none. */
  cgroupDir(sb: SandboxRecord): string | null;
  /** How many processes run in the sandbox now, when the cgroup's count is not that (gVisor counts the sandbox's own threads there). */
  processCount?(sb: SandboxRecord): number | null;
  /** The supervisor is closing: release what the tier holds outside any sandbox. */
  shutdown?(): void;
}

interface Exec {
  id: string;
  sandboxId: string;
  req: ExecRequest;
  server: Server;
  socketPath: string;
  child: ChildProcess | null;
  conn: Socket | null;
}

interface Live {
  record: SandboxRecord;
  owner: number;
  execs: Map<string, Exec>;
}

/**
 * The environment of every program the supervisor starts (runsc, bwrap, mount, cp): a search path and nothing else.
 * Not this process's own: the supervisor holds no credential, but a stray variable still changes what those programs
 * do. Seen once, not isolated: with a TMPDIR that named a directory that no longer existed, every runsc sandbox exited
 * before its container started.
 */
const childEnv = (): Record<string, string> => ({ PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" });

const sh = (argv: string[], opts: { timeoutMs?: number; input?: string } = {}): { code: number; out: string; err: string } => {
  const r = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", env: childEnv(), timeout: opts.timeoutMs ?? 60_000, ...(opts.input !== undefined ? { input: opts.input } : {}) });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: (r.stderr ?? "") + (r.error ? String(r.error.message) : "") };
};

const lastLine = (text: string): string => (text.trim().split("\n").at(-1) ?? "").slice(0, 300);

const readNumber = (path: string): number | null => {
  try {
    const t = readFileSync(path, "utf8").trim();
    return /^\d+$/.test(t) ? Number(t) : null;
  } catch {
    return null;
  }
};

/** The child processes of a process, from /proc. Empty when it has none or the kernel does not say. */
export function childrenOf(pid: number): number[] {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").split(/\s+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 1);
  } catch {
    return [];
  }
}

/** Give a tree to a uid and gid, entry by entry, never through a link. Entries that already match are left. */
export function adoptTree(root: string, uid: number, gid: number): number {
  let changed = 0;
  const visit = (p: string): void => {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    if (st.uid !== uid || st.gid !== gid) {
      try {
        lchownSync(p, uid, gid);
        changed++;
      } catch {
        /* a file that vanished, or one this process may not change */
      }
    }
    if (!st.isDirectory()) return;
    let names: string[] = [];
    try {
      names = readdirSync(p);
    } catch {
      return;
    }
    for (const name of names) visit(join(p, name));
  };
  visit(root);
  return changed;
}

/** Bytes of a tree by `du`, or 0 when it cannot be measured. */
function duBytes(path: string): number {
  if (!existsSync(path)) return 0;
  const r = sh(["du", "-sk", path], { timeoutMs: 20_000 });
  const kb = Number((r.out.split(/\s+/)[0] ?? "").trim());
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

// ---------------------------------------------------------------------------
// The gVisor backend
// ---------------------------------------------------------------------------

export function gvisorBackend(config: BoxdConfig): SandboxBackend {
  const runsc = config.runsc ?? "runsc";
  const stateDir = join(config.boxDir, "runsc");
  const cgroupRoot = config.cgroupRoot ?? "/sys/fs/cgroup";
  const container = (sb: { id: string }) => `slaude-${sb.id}`;
  const global = () => runscGlobalArgs(stateDir);
  return {
    tier: "gvisor",
    hostOwner: { uid: config.agentUid, gid: config.agentUid },
    probe() {
      if (process.platform !== "linux") return { ok: false, reason: "gVisor runs on Linux only" };
      if (process.getuid?.() !== 0) return { ok: false, reason: "the supervisor is not root" };
      const v = sh([runsc, "--version"], { timeoutMs: 10_000 });
      if (v.code !== 0) return { ok: false, reason: "runsc is not installed or does not run" };
      return { ok: true, version: (v.out.split("\n")[0] ?? "").replace(/^runsc version\s*/, "").trim() };
    },
    sweep() {
      const list = sh([runsc, ...global(), "list", "-quiet"], { timeoutMs: 20_000 });
      for (const id of list.out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("slaude-"))) {
        sh([runsc, ...global(), "kill", "--all", id, "KILL"], { timeoutMs: 10_000 });
        sh([runsc, ...global(), "delete", "--force", id], { timeoutMs: 20_000 });
      }
    },
    async start(sb) {
      const bundle = join(sb.dir, "bundle");
      mkdirSync(bundle, { recursive: true });
      mkdirSync(stateDir, { recursive: true });
      const spec = ociConfig({ name: sb.id, rootfs: sb.rootfs, overlayDir: sb.overlayDir, initDir: config.initDir, runDir: sb.runDir, mounts: sb.mounts, uid: sb.uid, gid: sb.gid, resources: sb.resources, env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/home/agent" } });
      writeFileSync(join(bundle, "config.json"), JSON.stringify(spec, null, 1));
      // A container of this name left by a failed start would refuse the next one.
      sh([runsc, ...global(), "delete", "--force", container(sb)], { timeoutMs: 20_000 });
      const logFd = openSync(join(sb.dir, "init.log"), "a");
      try {
        const args = runscRunArgs({ stateDir, overlayDir: sb.overlayDir, rootOverlayMb: sb.resources.rootOverlayMb, bundleDir: bundle, container: container(sb) });
        const r = spawnSync(runsc, args, { stdio: ["ignore", logFd, logFd], env: childEnv(), timeout: 60_000 });
        if (r.status !== 0) {
          let log = "";
          try {
            log = readFileSync(join(sb.dir, "init.log"), "utf8");
          } catch {
            /* no log */
          }
          throw new BoxdError("failed", `runsc did not start the sandbox (exit ${r.status ?? "none"}): ${lastLine(log)}`);
        }
      } finally {
        closeSync(logFd);
      }
    },
    exec(sb, req) {
      const args = runscExecArgs({ stateDir, container: container(sb), uid: sb.uid, gid: sb.gid, cwd: req.cwd, pidFile: join(req.scratch, "pid"), env: req.env, argv: req.argv });
      return spawn(runsc, args, { stdio: ["pipe", "pipe", "pipe"], env: childEnv() });
    },
    signal(sb, req, child, signal) {
      let pid = "";
      try {
        pid = readFileSync(join(req.scratch, "pid"), "utf8").trim();
      } catch {
        /* the process did not start, or already ended */
      }
      if (/^\d+$/.test(pid)) sh([runsc, ...global(), "kill", "--pid", pid, container(sb), signal.replace(/^SIG/, "")], { timeoutMs: 10_000 });
      else child.kill(signal as NodeJS.Signals);
    },
    async stop(sb) {
      sh([runsc, ...global(), "kill", "--all", container(sb), "KILL"], { timeoutMs: 10_000 });
      const d = sh([runsc, ...global(), "delete", "--force", container(sb)], { timeoutMs: 30_000 });
      if (d.code !== 0 && !/does not exist|not found/i.test(d.err)) throw new BoxdError("failed", `runsc did not delete the sandbox: ${lastLine(d.err)}`);
    },
    cgroupDir: (sb) => join(cgroupRoot, cgroupName(sb.id)),
    processCount(sb) {
      // One line per process after the header. The cgroup's pids.current counts host threads of the sandbox instead.
      const r = sh([runsc, ...global(), "ps", container(sb)], { timeoutMs: 10_000 });
      if (r.code !== 0) return null;
      return Math.max(0, r.out.trim().split("\n").length - 1);
    },
    shutdown() {
      // runsc keeps one network namespace mounted under its state directory for `--network none`.
      const ns = join(stateDir, "null-netns");
      if (existsSync(ns)) sh(["umount", ns], { timeoutMs: 10_000 });
    },
  };
}

// ---------------------------------------------------------------------------
// The bwrap backend
// ---------------------------------------------------------------------------

export function bwrapBackend(config: BoxdConfig): SandboxBackend {
  const bwrap = config.bwrap ?? "bwrap";
  const cgroupRoot = config.cgroupRoot ?? "/sys/fs/cgroup";
  const cg = (sb: { id: string }) => join(cgroupRoot, cgroupName(sb.id));
  const rootOf = (sb: SandboxRecord) => join(sb.dir, "root");
  const seccompPath = join(config.boxDir, "seccomp.bpf");
  const killCgroup = (dir: string): void => {
    if (!existsSync(dir)) return;
    try {
      writeFileSync(join(dir, "cgroup.kill"), "1");
    } catch {
      // A kernel without cgroup.kill: signal what is listed.
      try {
        for (const pid of readFileSync(join(dir, "cgroup.procs"), "utf8").split("\n").filter(Boolean)) {
          try {
            process.kill(Number(pid), "SIGKILL");
          } catch {
            /* gone */
          }
        }
      } catch {
        /* nothing to read */
      }
    }
  };
  const removeCgroup = async (dir: string): Promise<void> => {
    for (let i = 0; i < 50 && existsSync(dir); i++) {
      try {
        // rmdir of a cgroup works only once it holds no process.
        rmdirSync(dir);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  };
  const unmount = (path: string): void => {
    if (!existsSync(path)) return;
    const mounted = () => sh(["mountpoint", "-q", path], { timeoutMs: 5_000 }).code === 0;
    for (let i = 0; i < 5 && mounted(); i++) if (sh(["umount", path], { timeoutMs: 20_000 }).code !== 0) sh(["umount", "-l", path], { timeoutMs: 20_000 });
  };
  return {
    tier: "bwrap",
    // bwrap is run by the supervisor with its own uid mapped to the agent's: a box's files are the supervisor's on disk.
    hostOwner: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
    probe() {
      if (process.platform !== "linux") return { ok: false, reason: "the bwrap tier of the supervisor runs on Linux only" };
      if (process.getuid?.() !== 0) return { ok: false, reason: "the supervisor is not root" };
      const v = sh([bwrap, "--version"], { timeoutMs: 10_000 });
      if (v.code !== 0) return { ok: false, reason: "bwrap is not installed or does not run" };
      const t = sh([bwrap, "--unshare-user", "--uid", String(config.agentUid), "--gid", String(config.agentUid), "--disable-userns", "--unshare-pid", "--unshare-net", "--cap-drop", "ALL", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "/bin/true"], { timeoutMs: 10_000 });
      if (t.code !== 0) return { ok: false, reason: `bwrap cannot create its namespaces here: ${lastLine(t.err)}` };
      return { ok: true, version: v.out.trim().replace(/^bubblewrap\s*/, "") };
    },
    sweep() {
      let names: string[] = [];
      try {
        names = readdirSync(cgroupRoot).filter((n) => n.startsWith("slaude-box-"));
      } catch {
        names = [];
      }
      for (const n of names) {
        killCgroup(join(cgroupRoot, n));
        try {
          rmdirSync(join(cgroupRoot, n));
        } catch {
          /* still has processes dying; the next start of that sandbox removes it */
        }
      }
      const sessions = join(config.boxDir, "sessions");
      if (existsSync(sessions)) for (const s of readdirSync(sessions)) unmount(join(sessions, s, "root"));
    },
    async start(sb) {
      const root = rootOf(sb);
      const upper = join(sb.overlayDir, "upper");
      const work = join(sb.overlayDir, "work");
      for (const d of [root, upper, work]) mkdirSync(d, { recursive: true });
      unmount(root);
      const m = sh(["mount", "-t", "overlay", "overlay", "-o", `lowerdir=${sb.rootfs},upperdir=${upper},workdir=${work}`, root], { timeoutMs: 30_000 });
      if (m.code !== 0) throw new BoxdError("failed", `the root overlay could not be mounted: ${lastLine(m.err)}`);
      const dir = cg(sb);
      killCgroup(dir);
      await removeCgroup(dir);
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "memory.max"), String(sb.resources.memoryMb * 1024 * 1024));
        // A box that swaps instead of being stopped would hide the limit.
        try {
          writeFileSync(join(dir, "memory.swap.max"), "0");
        } catch {
          /* no swap controller */
        }
        // bwrap, its reaper and box-init are counted with the box's processes.
        writeFileSync(join(dir, "pids.max"), String(sb.resources.pids + 8));
        writeFileSync(join(dir, "cpu.max"), `${Math.max(1000, Math.round(sb.resources.cpu * 100_000))} 100000`);
      } catch (e) {
        unmount(root);
        throw new BoxdError("failed", `the sandbox's cgroup could not be set up: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!existsSync(seccompPath)) writeFileSync(seccompPath, seccompProgram(process.arch));
    },
    exec(sb, req) {
      const args = bwrapArgs({ root: rootOf(sb), initDir: config.initDir, runDir: sb.runDir, mounts: sb.mounts, uid: sb.uid, gid: sb.gid, cwd: req.cwd, env: req.env, argv: req.argv, seccompFd: 9 });
      // The shell joins the sandbox's cgroup before it becomes bwrap, so nothing bwrap starts is ever outside it; fd 9 is the seccomp filter.
      const script = 'echo $$ > "$1/cgroup.procs" || exit 70; shift; exec 9< "$1"; shift; exec "$@"';
      return spawn("/bin/sh", ["-c", script, "sh", cg(sb), seccompPath, bwrap, ...args], { stdio: ["pipe", "pipe", "pipe"], env: childEnv() });
    },
    signal(_sb, _req, child, signal) {
      // bwrap (our child) holds one child: the first process of the box's pid namespace, which holds box-init.
      // A hard end goes to that first process: the kernel then ends its whole namespace, bwrap reaps it and exits, and
      // nothing is orphaned. Ending bwrap itself would leave its child to die as an orphan, and an orphan is reaped
      // by pid 1, which in the supervisor's container is the supervisor: it would keep a zombie per ended process.
      // A soft end goes to box-init, which passes it to the command (the namespace's first process ignores it).
      const inner = child.pid ? childrenOf(child.pid) : [];
      const targets = signal === "SIGKILL" ? inner : inner.flatMap(childrenOf);
      if (targets.length === 0) return void child.kill(signal as NodeJS.Signals);
      for (const pid of targets) {
        try {
          process.kill(pid, signal as NodeJS.Signals);
        } catch {
          /* already gone */
        }
      }
    },
    async stop(sb) {
      const dir = cg(sb);
      // First the namespaces' first processes (see `signal`), then whatever is left.
      try {
        const procs = new Set(readFileSync(join(dir, "cgroup.procs"), "utf8").split("\n").filter(Boolean).map(Number));
        for (const pid of procs) {
          const comm = (() => {
            try {
              return readFileSync(`/proc/${pid}/comm`, "utf8").trim();
            } catch {
              return "";
            }
          })();
          if (comm !== "bwrap") continue;
          for (const c of childrenOf(pid)) {
            try {
              process.kill(c, "SIGKILL");
            } catch {
              /* already gone */
            }
          }
        }
        for (let i = 0; i < 20 && readFileSync(join(dir, "cgroup.procs"), "utf8").trim() !== ""; i++) await new Promise((r) => setTimeout(r, 50));
      } catch {
        /* no cgroup, or nothing in it */
      }
      killCgroup(dir);
      await removeCgroup(dir);
      unmount(rootOf(sb));
    },
    cgroupDir: (sb) => cg(sb),
  };
}

// ---------------------------------------------------------------------------
// cgroup v2 delegation and the supervisor's own limits
// ---------------------------------------------------------------------------

/**
 * Make it possible to create limited child cgroups (measured in the phase 0
 * spike). In a container with its own cgroup namespace the container's cgroup
 * holds boxd itself, and cgroup v2 refuses to enable controllers for children
 * of a cgroup that holds processes. So: move every process to a child (`init`)
 * and enable the controllers. On a plain host the root already delegates.
 * Returns a sentence when it cannot be done; boxd then refuses to start.
 */
export function delegateCgroup(cgroupRoot = "/sys/fs/cgroup"): string | null {
  const control = join(cgroupRoot, "cgroup.subtree_control");
  if (!existsSync(control)) return "this host does not have a cgroup v2 hierarchy at /sys/fs/cgroup";
  const has = () => {
    const c = readFileSync(control, "utf8").split(/\s+/);
    return c.includes("memory") && c.includes("pids") && c.includes("cpu");
  };
  let self = "";
  try {
    self = (readFileSync("/proc/self/cgroup", "utf8").trim().split("\n").at(-1) ?? "").split(":")[2] ?? "";
  } catch {
    self = "";
  }
  try {
    if (self === "/") {
      const procs = readFileSync(join(cgroupRoot, "cgroup.procs"), "utf8").split("\n").filter(Boolean);
      if (procs.length) {
        mkdirSync(join(cgroupRoot, "init"), { recursive: true });
        for (const pid of procs) {
          try {
            writeFileSync(join(cgroupRoot, "init", "cgroup.procs"), pid);
          } catch {
            /* a process that ended meanwhile */
          }
        }
      }
    }
    if (!has()) writeFileSync(control, "+cpu +memory +pids");
  } catch (e) {
    if (!has()) return `the memory, pids and cpu controllers cannot be enabled for child cgroups (${e instanceof Error ? e.message : String(e)}); a sandbox could not be limited`;
  }
  return has() ? null : "the memory, pids and cpu controllers are not enabled for child cgroups; a sandbox could not be limited";
}

// ---------------------------------------------------------------------------
// The supervisor
// ---------------------------------------------------------------------------

export interface Boxd {
  /** Handle one request of a connection. Exposed for tests; the socket server calls it. */
  request(conn: number, op: string, params: unknown): Promise<unknown>;
  /** A control connection ended. */
  disconnected(conn: number): void;
  listen(): Promise<void>;
  close(): Promise<void>;
  /** Sandboxes alive now. */
  sandboxes(): string[];
}

export interface BoxdDeps {
  backends?: Partial<Record<SandboxTier, SandboxBackend>>;
  images?: Pick<ImageStore, "rootfsOf" | "has" | "digests" | "importLayout" | "remove">;
  /** Runs a pack request off the supervisor's event loop. Default: a child process (src/box/boxd/pack-child.ts). */
  pack?: PackRunner;
}

/** Pack work, done somewhere that does not block stdio relays. */
export interface PackRunner {
  pack(unit: unknown, req: unknown, owner: { uid: number; gid: number }): Promise<{ layer: null | (Record<string, unknown> & { token: string }) }>;
  commit(token: string, id: string): Promise<void>;
  dispose(token: string): Promise<void>;
  apply(unit: unknown, req: unknown, owner: { uid: number; gid: number }): Promise<{ liveBytes?: number }>;
  clear(unit: unknown): Promise<void>;
  close(): void;
}

export function createBoxd(config: BoxdConfig, deps: BoxdDeps = {}): Boxd {
  const log = config.log ?? ((l: string) => console.log(l));
  const policy: PathPolicy = makePathPolicy({ boxDir: config.boxDir, mountRoots: config.mountRoots, roRoots: config.roRoots });
  const boxDir = policy.roots.boxDir;
  const images = deps.images ?? makeImageStore({ dir: boxDir, runner: cliImageRunner(), budgetMb: 0, log });
  const backends: Record<SandboxTier, SandboxBackend> = {
    gvisor: deps.backends?.gvisor ?? gvisorBackend({ ...config, boxDir }),
    bwrap: deps.backends?.bwrap ?? bwrapBackend({ ...config, boxDir }),
  };
  const packSpool = join(boxDir, "pack-spool");
  const pack = deps.pack ?? childPackRunner({ spoolDir: packSpool, log });
  const runtimeDir = dirname(config.socketPath);
  const live = new Map<string, Live>();
  const graceTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const chains = new Map<string, Promise<unknown>>();
  let server: Server | null = null;
  let nextConn = 1;
  let closing = false;
  /** Open control connections: ended when the supervisor closes, or it would never finish closing. */
  const control = new Set<Socket>();

  /** One operation on a sandbox at a time. */
  const serial = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const prev: Promise<unknown> = chains.has(id) ? chains.get(id)! : Promise.resolve();
    const p = prev.then(fn, fn);
    chains.set(id, p.catch(() => {}));
    return p;
  };

  const giveToClient = (path: string): void => {
    if (config.clientUid === undefined) return;
    try {
      chownSync(path, config.clientUid, config.clientGid ?? config.clientUid);
    } catch {
      /* not root: the socket stays boxd's */
    }
  };

  const sessionDir = (id: string) => join(boxDir, "sessions", id);

  function endExec(sb: Live, ex: Exec, signal = "SIGKILL"): void {
    if (ex.child && ex.child.exitCode === null && ex.child.signalCode === null) {
      try {
        backends[sb.record.tier].signal(sb.record, ex.req, ex.child, signal);
      } catch {
        /* the process is gone */
      }
      // The client end goes too once the process inside was told: a backend whose signal did nothing must not leave it.
      if (signal === "SIGKILL") setTimeout(() => ex.child?.kill("SIGKILL"), 500).unref?.();
    }
  }

  function forgetExec(sb: Live, ex: Exec, o: { keepConnection?: boolean } = {}): void {
    sb.execs.delete(ex.id);
    ex.server.close();
    // After a clean exit the connection still carries the last output and the exit status: it ends itself.
    if (!o.keepConnection) ex.conn?.destroy();
    try {
      unlinkSync(ex.socketPath);
    } catch {
      /* already gone */
    }
    rmSync(ex.req.scratch, { recursive: true, force: true });
  }

  async function stopSandbox(id: string): Promise<boolean> {
    const sb = live.get(id);
    if (!sb) return false;
    for (const ex of [...sb.execs.values()]) {
      endExec(sb, ex);
      forgetExec(sb, ex);
    }
    live.delete(id);
    try {
      await backends[sb.record.tier].stop(sb.record);
    } finally {
      // The root overlay is thrown away with the sandbox, always.
      rmSync(sb.record.overlayDir, { recursive: true, force: true });
      rmSync(join(sb.record.dir, "bundle"), { recursive: true, force: true });
      rmSync(join(sb.record.dir, "root"), { recursive: true, force: true });
      rmSync(join(sb.record.dir, "exec"), { recursive: true, force: true });
    }
    log(`[boxd] sandbox ${id} stopped`);
    return true;
  }

  /** An empty home gets what the image ships in /home/agent, once. */
  function seedHome(rootfs: string, home: string): void {
    const src = join(rootfs, "home", "agent");
    try {
      if (!existsSync(src) || readdirSync(home).length > 0) return;
    } catch {
      return;
    }
    const r = sh(["cp", "-a", `${src}/.`, `${home}/`], { timeoutMs: 120_000 });
    if (r.code !== 0) log(`[boxd] seeding a home from the image failed: ${lastLine(r.err)}`);
  }

  async function create(conn: number, p: Record<string, unknown>): Promise<{ created: boolean; imageEnv: Record<string, string> }> {
    const id = checkSandboxId(p.sandboxId);
    const tier = checkTier(p.tier);
    const digest = checkDigest(p.digest);
    const resources = checkResources(p.resources);
    const cwd = checkAbsolute(p.cwd, "cwd");
    const backend = backends[tier];
    return serial(id, async () => {
      const have = live.get(id);
      if (have) {
        if (have.record.digest !== digest || have.record.tier !== tier) throw new BoxdError("bad-request", "a sandbox of this id is running on another image or tier; stop it first");
        have.owner = conn;
        return { created: false, imageEnv: imageEnv(digest) };
      }
      const probe = backend.probe();
      if (!probe.ok) throw new BoxdError("unavailable", `tier ${tier} is not available: ${probe.reason ?? "unknown"}`);
      if (!images.has(digest)) throw new BoxdError("not-found", `the image ${digest.slice(7, 19)} is not in this node's image cache`);
      const dir = sessionDir(id);
      mkdirSync(dir, { recursive: true });
      // The run directory holds the worker's two sockets; boxd only mounts it.
      const runDir = policy.boxPath(p.runDir, "the run directory");
      if (!existsSync(runDir)) throw new BoxdError("bad-request", "the run directory does not exist");
      // Read-write sources under the box directory are boxd's to create (a first home).
      for (const m of (Array.isArray(p.mounts) ? p.mounts : []) as Array<Record<string, unknown>>) {
        if (m?.mode !== "rw" || typeof m.source !== "string") continue;
        const src = policy.mountSource(m.source, "rw");
        if (!existsSync(src) && (src === boxDir || src.startsWith(`${boxDir}/`))) mkdirSync(src, { recursive: true });
      }
      const mounts = checkMounts(p.mounts, policy);
      for (const m of mounts) if (!existsSync(m.source)) throw new BoxdError("bad-request", `a mount source does not exist (target ${m.target})`);
      const owner = backend.hostOwner;
      for (const m of mounts) {
        if (m.mode !== "rw") continue;
        if (m.target === "/home/agent") seedHome(images.rootfsOf(digest), m.source);
        adoptTree(m.source, owner.uid, owner.gid);
      }
      const overlayDir = join(dir, "overlay");
      rmSync(overlayDir, { recursive: true, force: true });
      mkdirSync(overlayDir, { recursive: true });
      const record: SandboxRecord = { id, tier, digest, rootfs: images.rootfsOf(digest), dir, overlayDir, runDir, mounts, cwd, resources, uid: config.agentUid, gid: config.agentUid, startedAt: Date.now() };
      try {
        await backend.start(record);
      } catch (e) {
        await backend.stop(record).catch(() => {});
        rmSync(overlayDir, { recursive: true, force: true });
        throw e;
      }
      live.set(id, { record, owner: conn, execs: new Map() });
      log(`[boxd] sandbox ${id} started (tier ${tier}, image ${digest.slice(7, 19)}, ${resources.memoryMb} MB, ${resources.pids} pids, ${resources.cpu} cpu)`);
      return { created: true, imageEnv: imageEnv(digest) };
    });
  }

  /** The image's own environment, when the image cache kept its config. Only PATH is ever used by the worker. */
  function imageEnv(digest: string): Record<string, string> {
    try {
      const cfg = JSON.parse(readFileSync(join(dirname(images.rootfsOf(digest)), "config.json"), "utf8")) as { process?: { env?: unknown }; config?: { Env?: unknown } };
      const list = (cfg.process?.env ?? cfg.config?.Env) as unknown;
      if (!Array.isArray(list)) return {};
      const out: Record<string, string> = {};
      for (const kv of list) if (typeof kv === "string" && kv.startsWith("PATH=")) out.PATH = kv.slice(5);
      return out;
    } catch {
      return {};
    }
  }

  /** A live sandbox. `own`: the asking connection becomes its owner (it starts processes in it); reading it does not. */
  function need(conn: number, v: unknown, own = false): Live {
    const id = checkSandboxId(v);
    const sb = live.get(id);
    if (!sb) throw new BoxdError("not-found", "no sandbox of this id is running");
    if (own) sb.owner = conn;
    return sb;
  }

  async function exec(conn: number, p: Record<string, unknown>): Promise<{ execId: string; stdio: string }> {
    const sb = need(conn, p.sandboxId, true);
    const argv = checkArgv(p.argv);
    const env = checkEnv(p.env);
    const cwd = checkAbsolute(p.cwd, "cwd");
    const id = randomBytes(8).toString("hex");
    const scratch = join(sb.record.dir, "exec", id);
    mkdirSync(scratch, { recursive: true });
    const socketPath = join(runtimeDir, `x-${id}.sock`);
    const ex: Exec = { id, sandboxId: sb.record.id, req: { argv, env, cwd, scratch }, server: createServer(), socketPath, child: null, conn: null };
    sb.execs.set(id, ex);
    await new Promise<void>((resolve, reject) => {
      ex.server.once("error", reject);
      ex.server.listen(socketPath, () => resolve());
    });
    chmodSync(socketPath, 0o600);
    giveToClient(socketPath);
    // A worker that never connects must not leave a listener behind.
    const unclaimed = setTimeout(() => {
      if (!ex.conn) forgetExec(sb, ex);
    }, 30_000);
    unclaimed.unref?.();
    ex.server.once("connection", (c: Socket) => {
      clearTimeout(unclaimed);
      ex.conn = c;
      ex.server.close();
      attach(sb, ex, c);
    });
    return { execId: id, stdio: socketPath };
  }

  /** Start the process and carry its stdio on the connection. */
  function attach(sb: Live, ex: Exec, c: Socket): void {
    let child: ChildProcess;
    try {
      child = backends[sb.record.tier].exec(sb.record, ex.req);
    } catch (e) {
      c.end(encodeFrame(FRAME.stderr, `boxd: the process could not be started: ${e instanceof Error ? e.message : String(e)}\n`));
      forgetExec(sb, ex);
      return;
    }
    ex.child = child;
    const decoder = frameDecoder();
    let exited = false;
    const send = (type: number, data: Uint8Array | string): boolean => (c.destroyed ? true : c.write(encodeFrame(type, data)));
    const pump = (stream: NodeJS.ReadableStream | null, type: number): void => {
      stream?.on("data", (d: Buffer) => {
        // One chunk may be larger than a frame.
        for (let at = 0; at < d.length; at += 256 * 1024) {
          if (!send(type, d.subarray(at, at + 256 * 1024))) {
            stream.pause();
            c.once("drain", () => stream.resume());
          }
        }
      });
    };
    pump(child.stdout, FRAME.stdout);
    pump(child.stderr, FRAME.stderr);
    child.stdin?.on("error", () => {});
    child.on("error", (e) => {
      send(FRAME.stderr, `boxd: ${e.message}\n`);
    });
    let streamsOpen = 2;
    let status: { code: number | null; signal: string | null } | null = null;
    const finish = () => {
      if (!status || streamsOpen > 0) return;
      c.end(encodeFrame(FRAME.exit, JSON.stringify(status)));
      forgetExec(sb, ex, { keepConnection: true });
    };
    for (const s of [child.stdout, child.stderr]) {
      if (!s) streamsOpen--;
      else s.once("close", () => (streamsOpen--, finish()));
    }
    child.once("exit", (code, signal) => {
      exited = true;
      status = { code, signal };
      finish();
      // A stream that some escaped grandchild keeps open must not hold the exit back for ever.
      setTimeout(() => {
        streamsOpen = 0;
        finish();
      }, 2_000).unref?.();
    });
    c.on("data", (d: Buffer) => {
      let frames;
      try {
        frames = decoder.push(d);
      } catch {
        endExec(sb, ex);
        c.destroy();
        return;
      }
      for (const f of frames) {
        if (f.type === FRAME.stdin) {
          if (child.stdin && !child.stdin.destroyed && !child.stdin.write(f.payload)) {
            c.pause();
            child.stdin.once("drain", () => c.resume());
          }
        } else if (f.type === FRAME.stdinEnd) child.stdin?.end();
        else if (f.type === FRAME.kill) {
          let sig = "SIGTERM";
          try {
            sig = checkSignal(f.payload.toString("utf8") || undefined);
          } catch {
            sig = "SIGTERM";
          }
          endExec(sb, ex, sig);
          // A process that ignores the signal is not left running: the hard one follows.
          if (sig !== "SIGKILL") setTimeout(() => !exited && endExec(sb, ex, "SIGKILL"), 5_000).unref?.();
        }
      }
    });
    c.on("error", () => {});
    c.once("close", () => {
      // The worker let go of the process (or died): it does not run on.
      if (!exited) endExec(sb, ex);
    });
  }

  function stats(conn: number, p: Record<string, unknown>) {
    const sb = need(conn, p.sandboxId);
    const dir = backends[sb.record.tier].cgroupDir(sb.record);
    const home = sb.record.mounts.find((m) => m.target === "/home/agent");
    return {
      memoryBytes: (dir && readNumber(join(dir, "memory.current"))) || 0,
      pids: backends[sb.record.tier].processCount?.(sb.record) ?? ((dir && readNumber(join(dir, "pids.current"))) || 0),
      homeBytes: home ? duBytes(home.source) : 0,
      overlayBytes: duBytes(sb.record.overlayDir),
    };
  }

  function probe(): ProbeResult {
    const cgroupRoot = config.cgroupRoot ?? "/sys/fs/cgroup";
    let disk: { total: number; free: number } | null = null;
    try {
      const s = statfsSync(boxDir);
      disk = { total: Number(s.blocks) * Number(s.bsize), free: Number(s.bavail) * Number(s.bsize) };
    } catch {
      disk = null;
    }
    return {
      protocol: BOXD_PROTOCOL_VERSION,
      tiers: { gvisor: backends.gvisor.probe(), bwrap: backends.bwrap.probe() },
      hostOwner: { gvisor: backends.gvisor.hostOwner, bwrap: backends.bwrap.hostOwner },
      // In a container with its own cgroup namespace this is the container's limit; on a plain host there is no file and so no limit.
      memoryLimitBytes: readNumber(join(cgroupRoot, "memory.max")),
      memoryUsedBytes: readNumber(join(cgroupRoot, "memory.current")),
      diskBytes: disk?.total ?? null,
      diskFreeBytes: disk?.free ?? null,
    };
  }

  const packUnit = (v: unknown) => {
    const u = (v ?? {}) as Record<string, unknown>;
    return { root: policy.dataPath(u.root, "a pack unit's root"), filter: u.filter, indexPath: policy.dataPath(u.indexPath, "a pack unit's index") };
  };
  const packOwner = () => backends[config.tier].hostOwner;

  async function request(conn: number, op: string, params: unknown): Promise<unknown> {
    if (closing) throw new BoxdError("unavailable", "the supervisor is stopping");
    const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
    switch (op) {
      case "probe":
        return probe();
      case "image.list":
        return { digests: images.digests() };
      case "image.import": {
        const m = await images.importLayout(policy.boxPath(p.layoutDir, "the image layout"), typeof p.image === "string" ? p.image : undefined);
        return { digest: m.digest };
      }
      case "image.remove": {
        const digest = checkDigest(p.digest);
        if ([...live.values()].some((s) => s.record.digest === digest)) throw new BoxdError("bad-request", "a running sandbox uses this image");
        return { removed: images.remove(digest) };
      }
      case "sandbox.create":
        return await create(conn, p);
      case "sandbox.exec":
        return await exec(conn, p);
      case "sandbox.kill": {
        const sb = need(conn, p.sandboxId);
        const signal = checkSignal(p.signal);
        const targets = typeof p.execId === "string" ? [sb.execs.get(p.execId)].filter((e): e is Exec => !!e) : [...sb.execs.values()];
        for (const ex of targets) endExec(sb, ex, signal);
        return { killed: targets.length };
      }
      case "sandbox.stats":
        return stats(conn, p);
      case "sandbox.stop": {
        const id = checkSandboxId(p.sandboxId);
        return { stopped: await serial(id, () => stopSandbox(id)) };
      }
      case "sandbox.list":
        return { sandboxes: [...live.values()].map((s) => ({ sandboxId: s.record.id, tier: s.record.tier, digest: s.record.digest, startedAt: s.record.startedAt, execs: s.execs.size })) };
      case "pack.pack":
        return await pack.pack(packUnit(p.unit), p.req, packOwner());
      case "pack.commit":
        if (typeof p.token !== "string" || typeof p.id !== "string") throw new BoxdError("bad-request", "pack.commit needs a token and an id");
        await pack.commit(p.token, p.id);
        return {};
      case "pack.dispose":
        if (typeof p.token !== "string") throw new BoxdError("bad-request", "pack.dispose needs a token");
        await pack.dispose(p.token);
        return {};
      case "pack.apply": {
        const req = (p.req ?? {}) as { id?: unknown; layers?: unknown };
        if (typeof req.id !== "string" || !Array.isArray(req.layers)) throw new BoxdError("bad-request", "pack.apply needs an id and layers");
        const layers = (req.layers as Array<Record<string, unknown>>).map((l) => ({ ...l, path: policy.boxPath(l.path, "a pack layer") }));
        return await pack.apply(packUnit(p.unit), { id: req.id, layers }, packOwner());
      }
      case "pack.clear":
        await pack.clear(packUnit(p.unit));
        return {};
      default:
        throw new BoxdError("bad-request", "unknown operation");
    }
  }

  function disconnected(conn: number): void {
    const owned = () => [...live.values()].filter((s) => s.owner === conn).map((s) => s.record.id);
    if (!owned().length) return;
    const t = setTimeout(() => {
      graceTimers.delete(conn);
      for (const id of owned()) {
        log(`[boxd] sandbox ${id}: its worker has been gone for ${Math.round((config.ownerGraceMs ?? 30_000) / 1000)} s, stopping it`);
        void serial(id, () => stopSandbox(id)).catch((e) => log(`[boxd] stopping sandbox ${id} failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    }, config.ownerGraceMs ?? 30_000);
    t.unref?.();
    graceTimers.set(conn, t);
  }

  function onConnection(c: Socket): void {
    if (closing) return void c.destroy();
    const conn = nextConn++;
    let buf = "";
    control.add(c);
    c.once("close", () => control.delete(c));
    c.setEncoding("utf8");
    c.on("error", () => {});
    c.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > 8 * 1024 * 1024) return void c.destroy();
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let id = 0;
        void (async () => {
          let res: BoxdResponse;
          try {
            const req = parseRequest(line);
            id = req.id;
            res = { id, ok: true, result: await request(conn, req.op, req.params) };
          } catch (e) {
            const err = e instanceof BoxdError ? e : new BoxdError("failed", e instanceof Error ? e.message : String(e));
            res = { id, ok: false, error: { code: err.code, message: err.message } };
          }
          if (!c.destroyed) c.write(`${JSON.stringify(res)}\n`);
        })();
      }
    });
    c.once("close", () => disconnected(conn));
  }

  return {
    request,
    disconnected,
    sandboxes: () => [...live.keys()],
    async listen() {
      mkdirSync(join(boxDir, "sessions"), { recursive: true });
      mkdirSync(packSpool, { recursive: true });
      mkdirSync(runtimeDir, { recursive: true });
      for (const b of Object.values(backends)) {
        try {
          if (b.probe().ok) b.sweep();
        } catch (e) {
          log(`[boxd] sweeping what an earlier supervisor left failed for tier ${b.tier}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // Overlays and bundles of sandboxes that no longer exist.
      for (const s of existsSync(join(boxDir, "sessions")) ? readdirSync(join(boxDir, "sessions")) : []) {
        for (const d of ["overlay", "bundle", "root", "exec"]) rmSync(join(boxDir, "sessions", s, d), { recursive: true, force: true });
      }
      for (const n of readdirSync(runtimeDir)) if (/^x-[a-f0-9]{16}\.sock$/.test(n)) rmSync(join(runtimeDir, n), { force: true });
      if (existsSync(config.socketPath)) unlinkSync(config.socketPath);
      server = createServer(onConnection);
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(config.socketPath, () => resolve());
      });
      chmodSync(config.socketPath, 0o600);
      giveToClient(config.socketPath);
    },
    async close() {
      // From here nothing new is started: a worker still connected must not get a sandbox from a supervisor that is leaving.
      closing = true;
      for (const t of graceTimers.values()) clearTimeout(t);
      graceTimers.clear();
      for (const c of control) c.destroy();
      control.clear();
      await Promise.all([...live.keys()].map((id) => serial(id, () => stopSandbox(id)).catch(() => {})));
      pack.close();
      for (const b of Object.values(backends)) {
        try {
          b.shutdown?.();
        } catch {
          /* nothing to release */
        }
      }
      // Once: closing a server that is already closed never calls back.
      const listening = server;
      server = null;
      await new Promise<void>((resolve) => (listening ? listening.close(() => resolve()) : resolve()));
      try {
        unlinkSync(config.socketPath);
      } catch {
        /* already gone */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Pack work in a child process
// ---------------------------------------------------------------------------

/**
 * Scanning a home of tens of thousands of files and compressing it is seconds
 * of work, and this process carries every box's stdio. So each pack request
 * runs in a child process (the same runtime, src/box/boxd/pack-child.ts). The
 * child of a `pack` stays until its layer is committed or disposed of, because
 * the index it built is what the commit writes.
 */
export function childPackRunner(o: { spoolDir: string; log?: (line: string) => void; entry?: string }): PackRunner {
  const entry = o.entry ?? join(import.meta.dir, "pack-child.ts");
  const pending = new Map<string, { child: ChildProcess; timer: ReturnType<typeof setTimeout> }>();

  /** Start a child, send it one request, read one JSON line back. The child is returned still running. */
  const run = (message: Record<string, unknown>): Promise<{ child: ChildProcess; reply: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--no-env-file", entry], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
      let out = "";
      let err = "";
      let settled = false;
      child.stderr?.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
      child.stdout?.on("data", (d: Buffer) => {
        out += d.toString();
        const nl = out.indexOf("\n");
        if (nl < 0 || settled) return;
        settled = true;
        try {
          resolve({ child, reply: JSON.parse(out.slice(0, nl)) as Record<string, unknown> });
        } catch {
          child.kill("SIGKILL");
          reject(new BoxdError("failed", "the pack process answered with something that is not JSON"));
        }
      });
      child.once("error", (e) => !settled && ((settled = true), reject(new BoxdError("failed", `the pack process could not be started: ${e.message}`))));
      child.once("exit", (code) => !settled && ((settled = true), reject(new BoxdError("failed", `the pack process ended early (exit ${code}): ${lastLine(err)}`))));
      child.stdin?.on("error", () => {});
      child.stdin?.write(`${JSON.stringify({ ...message, spoolDir: o.spoolDir })}\n`);
    });

  const check = (reply: Record<string, unknown>): Record<string, unknown> => {
    if (reply.ok === true) return reply;
    const e = (reply.error ?? {}) as { code?: string; message?: string; name?: string; data?: unknown };
    const err = new BoxdError("failed", String(e.message ?? "the pack request failed"));
    // The worker turns a few of these back into the errors the sync knows (a quota, a missing root).
    (err as BoxdError & { pack?: unknown }).pack = { name: e.name, data: e.data };
    throw err;
  };

  const second = (token: string, line: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const p = pending.get(token);
      if (!p) return reject(new BoxdError("not-found", "no packed layer of this token is waiting"));
      pending.delete(token);
      clearTimeout(p.timer);
      let out = "";
      p.child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
      p.child.once("exit", () => {
        try {
          check(JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      p.child.stdin?.end(`${line}\n`);
    });

  return {
    async pack(unit, req, owner) {
      const { child, reply } = await run({ op: "pack", unit, req, owner });
      let r: Record<string, unknown>;
      try {
        r = check(reply);
      } catch (e) {
        child.kill("SIGKILL");
        throw e;
      }
      if (r.layer === null || r.layer === undefined) {
        child.stdin?.end();
        return { layer: null };
      }
      const token = randomBytes(12).toString("hex");
      // A layer nobody commits is disposed of: the worker that asked may be gone.
      const timer = setTimeout(() => void second(token, JSON.stringify({ op: "dispose" })).catch(() => {}), 15 * 60_000);
      timer.unref?.();
      pending.set(token, { child, timer });
      return { layer: { ...(r.layer as Record<string, unknown>), token } };
    },
    commit: (token, id) => second(token, JSON.stringify({ op: "commit", id })),
    dispose: (token) => second(token, JSON.stringify({ op: "dispose" })),
    async apply(unit, req, owner) {
      const { child, reply } = await run({ op: "apply", unit, req, owner });
      child.stdin?.end();
      const r = check(reply);
      return typeof r.liveBytes === "number" ? { liveBytes: r.liveBytes } : {};
    },
    async clear(unit) {
      const { child, reply } = await run({ op: "clear", unit });
      child.stdin?.end();
      check(reply);
    },
    close() {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.child.kill("SIGKILL");
      }
      pending.clear();
    },
  };
}
