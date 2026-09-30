import { Client, type ClientChannel } from "ssh2";
import type { Duplex } from "node:stream";
import { PGRP_MARKER, wrapCommand } from "./shell";
import { RemoteError, type ExecOpts, type ExecResult } from "./types";

export type SocketFactory = () => Duplex | Promise<Duplex>;

export interface ConnOpts {
  socket: SocketFactory;
  privateKey: string;
  /** tailcat's server authenticates by key and runs as its own user; the name is informational. */
  username?: string;
  idleMs?: number;
  readyTimeoutMs?: number;
  reconnectDelayMs?: number;
}

const DEFAULT_HEAD = 30_000;
const TAIL = 4_000;
const KILL_GRACE_S = 5;

/** Collects a stream keeping the first `head` chars and the last TAIL chars. */
class Capped {
  #head = "";
  #tail = "";
  #dropped = 0;
  constructor(private head: number) {}
  push(s: string) {
    if (this.#head.length < this.head) {
      const room = this.head - this.#head.length;
      this.#head += s.slice(0, room);
      s = s.slice(room);
    }
    if (!s) return;
    this.#tail += s;
    if (this.#tail.length > TAIL) {
      this.#dropped += this.#tail.length - TAIL;
      this.#tail = this.#tail.slice(-TAIL);
    }
  }
  get truncated() { return this.#dropped > 0; }
  text(): string {
    return this.#dropped > 0
      ? `${this.#head}\n[truncated ${this.#dropped} chars]\n${this.#tail}`
      : this.#head + this.#tail;
  }
}

export class RemoteConn {
  #client: Client | null = null;
  #connecting: Promise<Client> | null = null;
  #idle: ReturnType<typeof setTimeout> | undefined;
  #active = 0;

  constructor(private o: ConnOpts) {}

  exec = async (cmd: string, opts: ExecOpts): Promise<ExecResult> => {
    try {
      return await this.#run(cmd, opts);
    } catch (e) {
      // Retry only failures before the command could have started: re-running a
      // half-executed, non-idempotent command is worse than reporting the drop.
      if (!(e instanceof RemoteError) || e.code !== "REMOTE_UNREACHABLE" || e.started) throw e;
      this.#drop();
      await new Promise((r) => setTimeout(r, this.o.reconnectDelayMs ?? 1000));
      return await this.#run(cmd, opts);
    }
  };

  close(): void {
    if (this.#idle) clearTimeout(this.#idle);
    this.#drop();
  }

  #drop() {
    const c = this.#client;
    this.#client = null;
    this.#connecting = null;
    try { c?.end(); } catch {}
  }

  #connect(): Promise<Client> {
    if (this.#client) return Promise.resolve(this.#client);
    if (this.#connecting) return this.#connecting;
    this.#connecting = (async () => {
      let sock: Duplex;
      try {
        sock = await this.o.socket();
      } catch (e) {
        throw new RemoteError("REMOTE_UNREACHABLE", `could not open transport: ${(e as Error).message}`);
      }
      const c = new Client();
      await new Promise<void>((resolve, reject) => {
        c.once("ready", () => resolve());
        c.once("error", (err: Error & { level?: string }) => {
          reject(
            err.level === "client-authentication"
              ? new RemoteError("REMOTE_AUTH_FAILED", "the remote rejected slaude's key (run /remote key)")
              : new RemoteError("REMOTE_UNREACHABLE", err.message),
          );
        });
        c.connect({
          sock: sock as any,
          username: this.o.username ?? "slaude",
          privateKey: this.o.privateKey,
          readyTimeout: this.o.readyTimeoutMs ?? 30_000,
          keepaliveInterval: 15_000,
          keepaliveCountMax: 3,
          // The tailcat address embeds the server's WireGuard key: the tunnel
          // already authenticates the peer (spec §2 "Host identity").
          hostVerifier: () => true,
        });
      });
      c.on("close", () => { if (this.#client === c) this.#client = null; });
      c.on("error", () => { if (this.#client === c) this.#client = null; });
      this.#client = c;
      this.#connecting = null;
      return c;
    })().catch((e) => {
      this.#connecting = null;
      throw e;
    });
    return this.#connecting;
  }

  async #run(cmd: string, opts: ExecOpts): Promise<ExecResult> {
    const client = await this.#connect();
    this.#active++;
    if (this.#idle) clearTimeout(this.#idle);
    try {
      return await this.#execOn(client, cmd, opts);
    } finally {
      this.#active--;
      if (this.#active === 0) {
        this.#idle = setTimeout(() => this.#drop(), this.o.idleMs ?? 10 * 60_000);
        (this.#idle as any).unref?.();
      }
    }
  }

  #execOn(client: Client, cmd: string, opts: ExecOpts): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      client.exec(wrapCommand(cmd, !!opts.login), (err, ch: ClientChannel) => {
        if (err) return reject(new RemoteError("REMOTE_UNREACHABLE", err.message));
        const out = new Capped(opts.maxOutput ?? DEFAULT_HEAD);
        let errBuf = "";
        let pgid: string | null = null;
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          if (pgid) this.#killGroup(client, pgid);
          ch.close();
        }, opts.timeoutMs);
        ch.on("data", (d: Buffer) => out.push(d.toString("utf8")));
        ch.stderr.on("data", (d: Buffer) => {
          errBuf += d.toString("utf8");
          if (!pgid) {
            const m = errBuf.match(new RegExp(`${PGRP_MARKER}(\\d+)\\n`));
            if (m) pgid = m[1]!;
          }
        });
        let code: number | null = null;
        let exited = false;
        ch.on("exit", (c: number | null) => { exited = true; code = typeof c === "number" ? c : null; });
        ch.on("close", () => {
          clearTimeout(timer);
          if (!exited && !timedOut) {
            // Channel closed without an exit status: the connection dropped
            // mid-command (laptop slept, tailcat stopped). Not a command result.
            this.#drop();
            return reject(new RemoteError("REMOTE_UNREACHABLE", "connection lost while the command was running; it may or may not have completed", true));
          }
          const stderr = errBuf.replace(new RegExp(`${PGRP_MARKER}\\d+\\n`), "");
          const note = timedOut ? `\n[timed out after ${opts.timeoutMs}ms; process group killed]` : "";
          resolve({ stdout: out.text(), stderr: stderr + note, code: timedOut ? null : code, truncated: out.truncated, timedOut });
        });
        if (opts.stdin !== undefined) ch.end(opts.stdin);
        else ch.end();
      });
      // No per-exec client listener: ssh2 closes every open channel when the
      // connection drops, so the channel "close" above always settles this promise.
    });
  }

  /** TERM the group, KILL it after a grace period. Fire-and-forget on the same connection. */
  #killGroup(client: Client, pgid: string) {
    const kill = `kill -TERM -${pgid} 2>/dev/null; i=0; while [ $i -lt ${KILL_GRACE_S} ]; do kill -0 -${pgid} 2>/dev/null || exit 0; sleep 1; i=$((i+1)); done; kill -KILL -${pgid} 2>/dev/null; exit 0`;
    client.exec(kill, (e, ch) => { if (!e) { ch.on("data", () => {}); ch.stderr.on("data", () => {}); ch.end(); } });
  }
}
