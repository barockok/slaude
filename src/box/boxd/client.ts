/**
 * The node worker's side of the box supervisor's protocol
 * (src/box/boxd/protocol.ts).
 *
 * One control connection, opened on first use and reopened after a loss. A
 * request that was in flight when the connection dropped fails; nothing is
 * replayed, because the supervisor may have done the work. `exec` gives back
 * an object the Agent SDK accepts as a spawned process: its stdio is carried
 * on a second socket that the supervisor names.
 *
 * The client holds no credential and sends none. What it sends is what the
 * worker decided: paths, limits, an environment already built for a box.
 */
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { Socket } from "node:net";
import { PassThrough, Writable } from "node:stream";
import { PackQuotaError, type AppliedLayer, type PackPort, type PackRequest, type PackUnitRef, type PackedLayer } from "../../storage/pack-sync";
import { RootMissingError } from "../../storage/tree-sync";
import { BoxdError, FRAME, encodeFrame, frameDecoder, type BoxdErrorCode, type BoxdOp, type BoxdOps, type BoxdResponse, type SandboxExecParams } from "./protocol";

export interface BoxdClientOpts {
  socketPath: string;
  /** How long one control request may take. Default 120 s (a sandbox start seeds and adopts a home). */
  requestTimeoutMs?: number;
}

/** A process in a box, in the shape the Agent SDK's `spawnClaudeCodeProcess` returns. */
export interface BoxProcess extends EventEmitter {
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  readonly killed: boolean;
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BoxdClient {
  readonly #opts: BoxdClientOpts;
  #sock: Socket | null = null;
  /** The connect in flight; meaningful only while `#dialing` is true (a promise is never read as a condition). */
  #connecting: Promise<Socket> | undefined;
  #dialing = false;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed = false;

  constructor(opts: BoxdClientOpts) {
    this.#opts = opts;
  }

  get socketPath(): string {
    return this.#opts.socketPath;
  }

  #connect(): Promise<Socket> {
    if (this.#sock && !this.#sock.destroyed) return Promise.resolve(this.#sock);
    if (this.#dialing) return this.#connecting as Promise<Socket>;
    this.#dialing = true;
    this.#connecting = new Promise<Socket>((resolve, reject) => {
      // Listeners first, then connect: under Bun a refused or missing Unix socket reports its error before a listener
      // attached after `connect()` can hear it, and an unheard error event takes the process down.
      const s = new Socket();
      let buf = "";
      s.setEncoding("utf8");
      s.once("connect", () => {
        this.#sock = s;
        this.#dialing = false;
        resolve(s);
      });
      // One way down for an error, an end and a close: under Bun a write to a connection the supervisor already dropped
      // can report an error and never a close, and a request waiting on that would wait out its whole timeout.
      const lost = (): void => {
        if (this.#sock === s) this.#sock = null;
        if (!s.destroyed) s.destroy();
        for (const [id, p] of this.#pending) {
          clearTimeout(p.timer);
          p.reject(new BoxdError("unavailable", "the connection to the box supervisor was lost"));
          this.#pending.delete(id);
        }
      };
      s.on("error", (e) => {
        if (this.#dialing) {
          this.#dialing = false;
          reject(new BoxdError("unavailable", `the box supervisor is not reachable: ${e.message}`));
          return;
        }
        lost();
      });
      s.once("end", lost);
      s.on("data", (chunk: string) => {
        buf += chunk;
        for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let res: BoxdResponse;
          try {
            res = JSON.parse(line) as BoxdResponse;
          } catch {
            continue;
          }
          const p = this.#pending.get(res.id);
          if (!p) continue;
          this.#pending.delete(res.id);
          clearTimeout(p.timer);
          if (res.ok) p.resolve(res.result);
          else p.reject(new BoxdError(res.error.code as BoxdErrorCode, res.error.message));
        }
      });
      s.once("close", lost);
      // No socket file: no supervisor. Said at once, without leaving it to how a runtime reports a failed connect.
      if (!existsSync(this.#opts.socketPath)) {
        this.#dialing = false;
        reject(new BoxdError("unavailable", "the box supervisor is not reachable: its socket does not exist"));
        return;
      }
      // A connect that neither succeeds nor fails (a socket file nobody listens on, seen to hang) is a failure too.
      const giveUp = setTimeout(() => {
        if (!this.#dialing) return;
        this.#dialing = false;
        s.destroy();
        reject(new BoxdError("unavailable", "the box supervisor is not reachable: it did not accept the connection"));
      }, 5_000);
      s.once("connect", () => clearTimeout(giveUp));
      s.once("error", () => clearTimeout(giveUp));
      s.connect(this.#opts.socketPath);
    });
    return this.#connecting;
  }

  async request<K extends BoxdOp>(op: K, params: BoxdOps[K]["params"], o: { timeoutMs?: number } = {}): Promise<BoxdOps[K]["result"]> {
    if (this.#closed) throw new BoxdError("unavailable", "the box supervisor client is closed");
    const s = await this.#connect();
    const id = this.#nextId++;
    return new Promise<BoxdOps[K]["result"]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new BoxdError("unavailable", `the box supervisor did not answer '${op}' in time`));
      }, o.timeoutMs ?? this.#opts.requestTimeoutMs ?? 120_000);
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      s.write(`${JSON.stringify({ id, op, params })}\n`);
    });
  }

  /** Whether the supervisor answers now. */
  async alive(timeoutMs = 2_000): Promise<boolean> {
    try {
      await this.request("probe", {}, { timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Start a process in a sandbox. Returns at once: the process object buffers
   * what is written to its stdin until the supervisor's stdio socket is
   * connected, and reports a start that failed as an `error` and an exit.
   */
  exec(params: SandboxExecParams): BoxProcess {
    const proc = new EventEmitter() as BoxProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let sock: Socket | null = null;
    let killed = false;
    let exitCode: number | null = null;
    let done = false;
    let wantKill: string | null = null;
    const queue: Buffer[] = [];
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (done) return;
      done = true;
      exitCode = code;
      stdout.end();
      stderr.end();
      proc.emit("exit", code, signal);
    };
    const fail = (e: Error): void => {
      if (done) return;
      if (proc.listenerCount("error") > 0) proc.emit("error", e);
      stderr.write(`${e.message}\n`);
      finish(127, null);
    };
    const stdin = new Writable({
      write(chunk: Buffer, _enc, cb) {
        const frame = encodeFrame(FRAME.stdin, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        if (!sock) {
          queue.push(frame);
          return cb();
        }
        if (sock.destroyed) return cb();
        sock.write(frame, () => cb());
      },
      final(cb) {
        const frame = encodeFrame(FRAME.stdinEnd);
        if (!sock) queue.push(frame);
        else if (!sock.destroyed) sock.write(frame);
        cb();
      },
    });
    stdin.on("error", () => {});
    Object.defineProperties(proc, {
      stdin: { value: stdin },
      stdout: { value: stdout },
      stderr: { value: stderr },
      killed: { get: () => killed },
      exitCode: { get: () => exitCode },
    });
    proc.kill = (signal: NodeJS.Signals = "SIGTERM"): boolean => {
      if (done) return false;
      killed = true;
      if (!sock) wantKill = signal;
      else if (!sock.destroyed) sock.write(encodeFrame(FRAME.kill, signal));
      return true;
    };

    void (async () => {
      let path: string;
      try {
        path = (await this.request("sandbox.exec", params)).stdio;
      } catch (e) {
        return fail(e instanceof Error ? e : new Error(String(e)));
      }
      const s = new Socket();
      const decoder = frameDecoder();
      s.once("connect", () => {
        sock = s;
        for (const f of queue.splice(0)) s.write(f);
        if (wantKill) s.write(encodeFrame(FRAME.kill, wantKill));
      });
      s.on("data", (d: Buffer) => {
        let frames;
        try {
          frames = decoder.push(d);
        } catch {
          s.destroy();
          return;
        }
        for (const f of frames) {
          // Not paused on a slow reader: a paused socket can report its close before the frames still queued on it
          // (the exit status among them) were read. The SDK reads the CLI's stdout as it comes.
          if (f.type === FRAME.stdout) stdout.write(f.payload);
          else if (f.type === FRAME.stderr) stderr.write(f.payload);
          else if (f.type === FRAME.exit) {
            let st: { code: number | null; signal: string | null } = { code: null, signal: null };
            try {
              st = JSON.parse(f.payload.toString("utf8")) as typeof st;
            } catch {
              /* an exit with no readable status */
            }
            finish(st.code, (st.signal as NodeJS.Signals | null) ?? null);
          }
        }
      });
      s.once("error", (e) => fail(new BoxdError("unavailable", `the stdio connection of a box process failed: ${e.message}`)));
      // The supervisor went away without an exit frame: the process is gone or unreachable.
      s.once("close", () => finish(exitCode ?? null, done ? null : "SIGKILL"));
      s.connect(path);
    })();
    return proc;
  }

  /** The supervisor as the file sync's packer. */
  packer(spoolDir: string): PackPort {
    const client = this;
    const translate = (e: unknown, unit: PackUnitRef): never => {
      const msg = e instanceof Error ? e.message : String(e);
      const quota = /pack refused: the tree holds (\d+) bytes, over the (\d+) byte ceiling/.exec(msg);
      if (quota) throw new PackQuotaError(Number(quota[1]), Number(quota[2]));
      if (/is missing: refusing to commit an empty tree/.test(msg)) throw new RootMissingError(unit.filter.kind === "ignored" ? "wx" : "hm", unit.root);
      throw e;
    };
    return {
      spoolDir,
      async pack(unit: PackUnitRef, req: PackRequest): Promise<PackedLayer | null> {
        let layer;
        try {
          layer = (await client.request("pack.pack", { unit, req }, { timeoutMs: 15 * 60_000 })).layer;
        } catch (e) {
          return translate(e, unit);
        }
        if (!layer) return null;
        const { token, ...rest } = layer;
        let settled = false;
        return {
          ...(rest as unknown as Omit<PackedLayer, "commit" | "dispose">),
          async commit(id: string) {
            // The supervisor writes the index and deletes the spool file in one step.
            settled = true;
            await client.request("pack.commit", { token, id });
          },
          async dispose() {
            if (settled) return;
            settled = true;
            await client.request("pack.dispose", { token }).catch(() => {});
          },
        };
      },
      async apply(unit: PackUnitRef, req: { id: string; layers: AppliedLayer[] }) {
        return client.request("pack.apply", { unit, req }, { timeoutMs: 15 * 60_000 });
      },
      async clear(unit: PackUnitRef) {
        await client.request("pack.clear", { unit }, { timeoutMs: 5 * 60_000 });
      },
    };
  }

  close(): void {
    this.#closed = true;
    this.#sock?.destroy();
    this.#sock = null;
  }
}
