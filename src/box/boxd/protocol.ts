/**
 * The protocol between a node worker and the box supervisor (boxd).
 *
 * Control: newline-delimited JSON over the Unix socket SLAUDE_BOXD_SOCKET.
 * One request, one response, matched by `id`:
 *
 *   -> {"id":1,"op":"sandbox.create","params":{...}}
 *   <- {"id":1,"ok":true,"result":{...}}
 *   <- {"id":1,"ok":false,"error":{"code":"bad-request","message":"..."}}
 *
 * A process's stdio does not travel on the control socket. `sandbox.exec`
 * answers with the path of a second Unix socket; the process starts when the
 * worker connects to it, and its stdin, stdout, stderr and exit status are
 * framed on that connection (see the frame types below). Closing that
 * connection ends the process.
 *
 * boxd is privileged and trusts no argument. Every path a request names is
 * checked here, after `realpath`, against the box directory and the mount
 * roots boxd was started with. A request cannot name an image by path at all:
 * it names a digest, and the root filesystem is where the image cache put it.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import type { BoxTier } from "../policy";

export const BOXD_PROTOCOL_VERSION = 1;

/** Where the run directory (the two proxy sockets) appears inside a box. */
export const BOX_RUN_TARGET = "/run/slaude";
/** Where the directory holding box-init appears inside a box. */
export const BOX_INIT_TARGET = "/.slaude";
export const BOX_INIT_BIN = `${BOX_INIT_TARGET}/box-init`;

export type SandboxTier = Exclude<BoxTier, "none">;

export interface ProtocolMount {
  source: string;
  target: string;
  mode: "ro" | "rw";
}

export interface SandboxCreateParams {
  sandboxId: string;
  tier: SandboxTier;
  /** The pinned image, `sha256:<hex>`. Never a path. */
  digest: string;
  mounts: ProtocolMount[];
  /** The session's run directory: holds egress.sock and llm.sock, mounted at /run/slaude. */
  runDir: string;
  cwd: string;
  resources: { cpu: number; memoryMb: number; pids: number; rootOverlayMb: number };
}

export interface SandboxExecParams {
  sandboxId: string;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
}

export interface PackUnitParams {
  root: string;
  filter: unknown;
  indexPath: string;
}

export interface BoxdOps {
  probe: { params: Record<string, never>; result: ProbeResult };
  "image.list": { params: Record<string, never>; result: { digests: string[] } };
  "image.import": { params: { layoutDir: string; image?: string }; result: { digest: string } };
  "image.remove": { params: { digest: string }; result: { removed: boolean } };
  "sandbox.create": { params: SandboxCreateParams; result: { created: boolean; imageEnv: Record<string, string> } };
  "sandbox.exec": { params: SandboxExecParams; result: { execId: string; stdio: string } };
  "sandbox.kill": { params: { sandboxId: string; execId?: string; signal?: string }; result: { killed: number } };
  "sandbox.stats": { params: { sandboxId: string }; result: { memoryBytes: number; pids: number; homeBytes: number; overlayBytes: number } };
  "sandbox.stop": { params: { sandboxId: string }; result: { stopped: boolean } };
  "sandbox.list": { params: Record<string, never>; result: { sandboxes: Array<{ sandboxId: string; tier: SandboxTier; digest: string; startedAt: number; execs: number }> } };
  "pack.pack": { params: { unit: PackUnitParams; req: unknown }; result: { layer: null | (Record<string, unknown> & { token: string }) } };
  "pack.commit": { params: { token: string; id: string }; result: Record<string, never> };
  "pack.dispose": { params: { token: string }; result: Record<string, never> };
  "pack.apply": { params: { unit: PackUnitParams; req: { id: string; layers: Array<{ path: string; hash: string; removed: string[] }> } }; result: { liveBytes?: number } };
  "pack.clear": { params: { unit: PackUnitParams }; result: Record<string, never> };
}

export type BoxdOp = keyof BoxdOps;

export interface TierProbe {
  ok: boolean;
  reason?: string;
  version?: string;
}

export interface ProbeResult {
  protocol: number;
  tiers: Record<SandboxTier, TierProbe>;
  /** The uid and gid a box's files have on the node's disk, per tier. */
  hostOwner: Record<SandboxTier, { uid: number; gid: number }>;
  /** boxd's cgroup memory limit and use, or null when it has no limit or it cannot be read. */
  memoryLimitBytes: number | null;
  memoryUsedBytes: number | null;
  /** The box data volume. */
  diskBytes: number | null;
  diskFreeBytes: number | null;
}

export interface BoxdRequest {
  id: number;
  op: string;
  params?: unknown;
}

export type BoxdResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: { code: BoxdErrorCode; message: string } };

export type BoxdErrorCode = "bad-request" | "path-refused" | "not-found" | "unavailable" | "failed";

/** A refusal or failure boxd reports. The message never holds a secret: boxd has none. */
export class BoxdError extends Error {
  override readonly name = "BoxdError";
  constructor(
    readonly code: BoxdErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Stdio frames on an exec socket: 1 byte type, 4 bytes big-endian length, payload.
// ---------------------------------------------------------------------------

export const FRAME = {
  /** worker -> boxd */
  stdin: 0x01,
  stdinEnd: 0x02,
  /** payload: a signal name */
  kill: 0x03,
  /** boxd -> worker */
  stdout: 0x11,
  stderr: 0x12,
  /** payload: JSON {"code":number|null,"signal":string|null} */
  exit: 0x13,
} as const;

export const MAX_FRAME_BYTES = 1024 * 1024;

export function encodeFrame(type: number, payload: Uint8Array | string = new Uint8Array(0)): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

/** Split a stream of bytes into frames. `push` returns the frames completed by the chunk. Throws on an oversized frame. */
export function frameDecoder(): { push(chunk: Uint8Array): Array<{ type: number; payload: Buffer }> } {
  let buf: Buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
      const out: Array<{ type: number; payload: Buffer }> = [];
      for (;;) {
        if (buf.length < 5) break;
        const len = buf.readUInt32BE(1);
        if (len > MAX_FRAME_BYTES) throw new BoxdError("bad-request", "a stdio frame is larger than the limit");
        if (buf.length < 5 + len) break;
        out.push({ type: buf[0]!, payload: Buffer.from(buf.subarray(5, 5 + len)) });
        buf = buf.subarray(5 + len);
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGQUIT"]);

const bad = (message: string) => new BoxdError("bad-request", message);
const refused = (message: string) => new BoxdError("path-refused", message);

export function checkSandboxId(v: unknown): string {
  if (typeof v !== "string" || !ID_RE.test(v) || v.includes("..")) throw bad("the sandbox id is not a single safe path segment");
  return v;
}

export function checkDigest(v: unknown): string {
  if (typeof v !== "string" || !DIGEST_RE.test(v)) throw bad("the image digest is not sha256:<64 hex digits>");
  return v;
}

export function checkTier(v: unknown): SandboxTier {
  if (v !== "gvisor" && v !== "bwrap") throw bad("the tier is not gvisor or bwrap");
  return v;
}

export function checkSignal(v: unknown): string {
  const s = v === undefined ? "SIGTERM" : v;
  if (typeof s !== "string" || !SIGNALS.has(s)) throw bad("the signal is not one boxd sends");
  return s;
}

/** A sandbox process's environment as boxd accepts it: plain names, string values, no NUL, no newline in a name. */
export function checkEnv(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw bad("env is not an object");
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!ENV_NAME_RE.test(k)) throw bad("an environment name is not a plain variable name");
    if (typeof val !== "string" || val.includes("\0")) throw bad(`the value of ${k} is not a string`);
    out[k] = val;
  }
  return out;
}

export function checkArgv(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > 4096) throw bad("argv is not a non-empty list");
  for (const a of v) if (typeof a !== "string" || a.includes("\0")) throw bad("an argument is not a string");
  if (!isAbsolute(v[0] as string)) throw bad("the command is not an absolute path");
  return v as string[];
}

/** An absolute, normalized path with no `..`, no NUL and no trailing slash games. Not resolved. */
export function checkAbsolute(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 4096 || v.includes("\0")) throw bad(`${what} is not a path`);
  if (!isAbsolute(v)) throw bad(`${what} is not an absolute path`);
  if (v.split("/").includes("..")) throw refused(`${what} contains a '..' segment`);
  const n = normalize(v);
  return n.length > 1 && n.endsWith(sep) ? n.slice(0, -1) : n;
}

/** Paths inside a box that a mount may not cover or sit on. */
const RESERVED_TARGETS = ["/proc", "/sys", "/dev", BOX_RUN_TARGET, BOX_INIT_TARGET];

export function checkTarget(v: unknown): string {
  const t = checkAbsolute(v, "a mount target");
  if (t === "/") throw refused("a mount may not cover the root of a box");
  for (const r of RESERVED_TARGETS) if (t === r || t.startsWith(`${r}/`) || r.startsWith(`${t}/`)) throw refused(`a mount may not cover ${r}`);
  return t;
}

const inside = (root: string, p: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * `realpath` of a path that may not exist yet: the deepest existing ancestor is
 * resolved and the missing tail is appended. A symlink anywhere in the existing
 * part is followed, so the answer is where a later mkdir or open would land.
 */
export function resolveExisting(p: string): string {
  let head = p;
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    tail.unshift(head.slice(parent.length).replace(/^\/+/, ""));
    head = parent;
  }
  let real: string;
  try {
    real = realpathSync(head);
  } catch {
    throw refused("a path could not be resolved");
  }
  return tail.length ? join(real, ...tail) : real;
}

export interface PathRoots {
  /** SLAUDE_BOX_DIR. */
  boxDir: string;
  /** Directories a box may be given read-write (and read-only): workspaces, config homes, scratch. */
  mountRoots: readonly string[];
  /** Directories a box may be given read-only only: the node image's own files (the CLI, plugins). */
  roRoots: readonly string[];
}

export interface PathPolicy {
  roots: PathRoots;
  /** The resolved source of a mount, or a throw. A read-write mount must be under the box directory or a mount root. */
  mountSource(path: unknown, mode: "ro" | "rw"): string;
  /** A path boxd itself reads or writes for the worker (a pack unit's root, an index, an archive): under the box directory or a mount root. */
  dataPath(path: unknown, what: string): string;
  /** A path under the box directory only. */
  boxPath(path: unknown, what: string): string;
}

/**
 * The rule for every path a request names. Roots are resolved once, when boxd
 * starts. A path is accepted when, after `realpath`, it is inside a root: a
 * symlink that leads out of every root is refused, whatever its name.
 */
export function makePathPolicy(roots: PathRoots): PathPolicy {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return normalize(p);
    }
  };
  const boxDir = real(roots.boxDir);
  const rw = [boxDir, ...roots.mountRoots.map(real)];
  const ro = [...rw, ...roots.roRoots.map(real)];
  // boxd's own state under the box directory is never handed to a box or to a pack request.
  const privateDirs = [join(boxDir, "runsc"), join(boxDir, "cgroup")];
  const check = (v: unknown, what: string, allowed: readonly string[]): string => {
    const p = resolveExisting(checkAbsolute(v, what));
    if (privateDirs.some((d) => inside(d, p))) throw refused(`${what} is inside the supervisor's own state`);
    if (!allowed.some((r) => inside(r, p))) throw refused(`${what} is outside the box directory and the mount roots`);
    return p;
  };
  return {
    roots: { boxDir, mountRoots: rw.slice(1), roRoots: ro.slice(rw.length) },
    mountSource: (path, mode) => {
      const p = check(path, "a mount source", mode === "rw" ? rw : ro);
      // The image cache is shared by every box: never writable, and never mounted by path (a box gets its image by digest).
      if (inside(join(boxDir, "images"), p)) throw refused("a mount source is inside the image cache");
      return p;
    },
    dataPath: (path, what) => {
      const p = check(path, what, rw);
      if (inside(join(boxDir, "images"), p)) throw refused(`${what} is inside the image cache`);
      return p;
    },
    boxPath: (path, what) => check(path, what, [boxDir]),
  };
}

export function checkMounts(v: unknown, policy: PathPolicy): ProtocolMount[] {
  if (!Array.isArray(v) || v.length > 64) throw bad("mounts is not a list");
  const out: ProtocolMount[] = [];
  const targets = new Set<string>();
  for (const m of v as Array<Record<string, unknown>>) {
    if (!m || typeof m !== "object") throw bad("a mount is not an object");
    const mode = m.mode;
    if (mode !== "ro" && mode !== "rw") throw bad("a mount's mode is not ro or rw");
    const target = checkTarget(m.target);
    if (targets.has(target)) throw bad("two mounts have the same target");
    targets.add(target);
    out.push({ source: policy.mountSource(m.source, mode), target, mode });
  }
  return out;
}

export function checkResources(v: unknown): SandboxCreateParams["resources"] {
  const r = (v ?? {}) as Record<string, unknown>;
  const num = (name: string, min: number, max: number): number => {
    const n = r[name];
    if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) throw bad(`resources.${name} is not a number between ${min} and ${max}`);
    return n;
  };
  return { cpu: num("cpu", 0.05, 512), memoryMb: Math.floor(num("memoryMb", 64, 4 * 1024 * 1024)), pids: Math.floor(num("pids", 16, 4_000_000)), rootOverlayMb: Math.floor(num("rootOverlayMb", 16, 16 * 1024 * 1024)) };
}

export function parseRequest(line: string): BoxdRequest {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    throw bad("a request is not JSON");
  }
  const r = v as Record<string, unknown>;
  if (!r || typeof r !== "object" || typeof r.id !== "number" || typeof r.op !== "string") throw bad("a request has no id or no op");
  return { id: r.id, op: r.op, params: r.params };
}
