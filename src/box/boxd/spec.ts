/**
 * What a sandbox is made of, as pure data: the OCI `config.json` a gVisor
 * sandbox runs from, and the argument lists of `runsc` and `bwrap`. Kept apart
 * from the supervisor's process handling so each can be compared with a golden
 * value in a test that needs no Linux.
 *
 * The configuration is the one the phase 0 spikes chose and corrected (field
 * note 2026-11-24-box-spikes):
 *
 *   - runsc `systrap`, `--network none`, `--host-uds open` (a bind-mounted host
 *     socket is refused without it), the root overlay on a per-session
 *     directory with a size limit, bind mounts in the default shared mode;
 *   - `root.readonly` is FALSE. With `true` the root is read-only even under
 *     the overlay. The image directory is protected by the overlay, not by
 *     that flag;
 *   - every capability dropped, `noNewPrivileges`, the agent user;
 *   - the cgroup `pids` limit counts host threads of the sandbox (about thirty
 *     idle, and two to three per process), and a sandbox that reaches it does
 *     not refuse a fork: its own kernel process cannot start a thread and the
 *     whole sandbox stops (measured). So the cgroup limit is written well
 *     above the box's process limit, as a backstop, and the box's own limit
 *     is given to the sandbox as RLIMIT_NPROC;
 *   - box-init is the first process.
 */
import { BOX_INIT_BIN, BOX_INIT_TARGET, BOX_RUN_TARGET, type ProtocolMount } from "./protocol";

export interface SandboxSpecInput {
  /** The supervisor's name for the sandbox (a cgroup and container name). */
  name: string;
  rootfs: string;
  /** The directory that holds the root overlay's backing data. */
  overlayDir: string;
  /** The directory holding box-init, on the supervisor's side. */
  initDir: string;
  runDir: string;
  mounts: readonly ProtocolMount[];
  /** The agent user: who every process the worker starts runs as. */
  uid: number;
  gid: number;
  resources: { cpu: number; memoryMb: number; pids: number; rootOverlayMb: number };
  /** The environment of box-init. Nothing of the node's. */
  env: Record<string, string>;
}

export const BOX_HOSTNAME = "box";

/**
 * Who box-init runs as in a gVisor sandbox: not the agent. RLIMIT_NPROC is
 * counted per user, threads included, so an agent at its process limit would
 * otherwise stop box-init from starting a thread, and the first process of a
 * sandbox ending is the sandbox ending (measured: a fork loop took the whole
 * sandbox down). It needs nothing of the agent's: it listens on loopback and
 * connects to two sockets anyone in the box may connect to.
 */
export const BOX_INIT_UID = 65534;
const CPU_PERIOD = 100_000;

/** The sandbox's own threads, which the pids controller counts with the box's processes (measured: 25 to 30 idle, 2.3 per process). */
const GVISOR_SANDBOX_THREADS = 64;
const GVISOR_THREADS_PER_PROCESS = 4;

/** The `pids` limit written for a gVisor sandbox whose box allows `pids` processes. */
export const gvisorPidsLimit = (pids: number): number => pids * GVISOR_THREADS_PER_PROCESS + GVISOR_SANDBOX_THREADS;

/** The cgroup a sandbox runs in, relative to the supervisor's cgroup root. One level, so it is a child of the supervisor's container. */
export const cgroupName = (name: string): string => `slaude-box-${name}`;

const NO_CAPS = { bounding: [], effective: [], inheritable: [], permitted: [], ambient: [] } as const;

/** Mounts every box gets, before its own. */
const BASE_MOUNTS = [
  { destination: "/proc", type: "proc", source: "proc" },
  { destination: "/dev", type: "tmpfs", source: "tmpfs", options: ["nosuid", "strictatime", "mode=755", "size=65536k"] },
  { destination: "/dev/pts", type: "devpts", source: "devpts", options: ["nosuid", "noexec", "newinstance", "ptmxmode=0666", "mode=0620"] },
  { destination: "/dev/shm", type: "tmpfs", source: "shm", options: ["nosuid", "noexec", "nodev", "mode=1777", "size=65536k"] },
  { destination: "/sys", type: "sysfs", source: "sysfs", options: ["nosuid", "noexec", "nodev", "ro"] },
] as const;

const envList = (env: Record<string, string>): string[] =>
  Object.keys(env)
    .sort()
    .map((k) => `${k}=${env[k]}`);

/** The OCI runtime configuration of a gVisor sandbox. */
export function ociConfig(i: SandboxSpecInput): Record<string, unknown> {
  const bind = (source: string, destination: string, mode: "ro" | "rw") => ({ destination, type: "bind", source, options: ["rbind", mode] });
  return {
    ociVersion: "1.0.2",
    process: {
      terminal: false,
      user: { uid: BOX_INIT_UID, gid: BOX_INIT_UID },
      args: [BOX_INIT_BIN],
      env: envList(i.env),
      cwd: "/",
      capabilities: NO_CAPS,
      noNewPrivileges: true,
      // Inherited by every process started in the sandbox, and counted for the agent user apart from box-init's.
      rlimits: [{ type: "RLIMIT_NPROC", hard: i.resources.pids, soft: i.resources.pids }],
    },
    // False on purpose: see the header. Every write lands in the overlay.
    root: { path: i.rootfs, readonly: false },
    hostname: BOX_HOSTNAME,
    mounts: [
      ...BASE_MOUNTS,
      ...i.mounts.map((m) => bind(m.source, m.target, m.mode)),
      bind(i.runDir, BOX_RUN_TARGET, "ro"),
      bind(i.initDir, BOX_INIT_TARGET, "ro"),
    ],
    linux: {
      cgroupsPath: `/${cgroupName(i.name)}`,
      resources: {
        memory: { limit: i.resources.memoryMb * 1024 * 1024 },
        pids: { limit: gvisorPidsLimit(i.resources.pids) },
        cpu: { quota: Math.max(1000, Math.round(i.resources.cpu * CPU_PERIOD)), period: CPU_PERIOD },
      },
      namespaces: [{ type: "pid" }, { type: "ipc" }, { type: "uts" }, { type: "mount" }, { type: "network" }],
    },
  };
}

/** Flags every runsc command of this supervisor carries. */
export function runscGlobalArgs(stateDir: string): string[] {
  return ["--root", stateDir, "--platform", "systrap", "--network", "none", "--host-uds", "open"];
}

export function runscRunArgs(o: { stateDir: string; overlayDir: string; rootOverlayMb: number; bundleDir: string; container: string }): string[] {
  return [...runscGlobalArgs(o.stateDir), "--overlay2", `root:dir=${o.overlayDir},size=${o.rootOverlayMb}m`, "run", "--detach", "--bundle", o.bundleDir, o.container];
}

/**
 * One process in a running gVisor sandbox. `--new-pidns` makes it the first
 * process of its own pid namespace, so ending it ends everything it started;
 * the pid file is what `runsc kill --pid` is given. Killing the `exec` client
 * alone does not end the process inside (measured).
 */
export function runscExecArgs(o: { stateDir: string; container: string; uid: number; gid: number; cwd: string; pidFile: string; env: Record<string, string>; argv: readonly string[] }): string[] {
  return [
    ...runscGlobalArgs(o.stateDir),
    "exec",
    "--user",
    `${o.uid}:${o.gid}`,
    "--cwd",
    o.cwd,
    "--internal-pid-file",
    o.pidFile,
    "--new-pidns",
    ...envList(o.env).flatMap((kv) => ["--env", kv]),
    o.container,
    ...o.argv,
  ];
}

/**
 * One process in a bwrap box. There is no long-lived sandbox process on this
 * tier: every process the worker starts is its own `bwrap` with its own pid,
 * network, ipc and uts namespaces, on the session's root overlay and mounts,
 * with box-init in front of it for the two relays. Ending bwrap ends
 * everything in its pid namespace (`--die-with-parent`).
 *
 * bwrap is run by the supervisor (root) with a user namespace in which its
 * own uid appears as the agent's: inside, the process is the agent user with
 * no capability, and further user namespaces are disabled.
 */
export function bwrapArgs(o: {
  root: string;
  initDir: string;
  runDir: string;
  mounts: readonly ProtocolMount[];
  uid: number;
  gid: number;
  cwd: string;
  env: Record<string, string>;
  argv: readonly string[];
  /** A file descriptor number that holds a compiled seccomp filter, when one is used. */
  seccompFd?: number;
}): string[] {
  const args = [
    "--unshare-user",
    "--uid",
    String(o.uid),
    "--gid",
    String(o.gid),
    "--disable-userns",
    "--unshare-pid",
    "--unshare-net",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--hostname",
    BOX_HOSTNAME,
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--bind",
    o.root,
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
  ];
  for (const m of o.mounts) args.push(m.mode === "rw" ? "--bind" : "--ro-bind", m.source, m.target);
  args.push("--ro-bind", o.runDir, BOX_RUN_TARGET, "--ro-bind", o.initDir, BOX_INIT_TARGET);
  if (o.seccompFd !== undefined) args.push("--seccomp", String(o.seccompFd));
  args.push("--chdir", o.cwd, "--clearenv");
  for (const k of Object.keys(o.env).sort()) args.push("--setenv", k, o.env[k]!);
  args.push("--", BOX_INIT_BIN, "run", "--", ...o.argv);
  return args;
}
