import { Client, type ClientChannel } from "ssh2";
import type { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
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
/** After a timeout we ask the remote to close the channel; if it never answers the link is dead. */
const KILL_SETTLE_MS = 3_000;
/** The process-group marker is the first thing the wrapper prints; give up looking after this much stderr. */
const MARKER_SCAN_MAX = 4_096;
const MARKER_RE = new RegExp(`${PGRP_MARKER}(\\d+)\\n`);

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

const lostError = () =>
  new RemoteError("REMOTE_UNREACHABLE", "connection lost while the command was running; it may or may not have completed", true);

export class RemoteConn {
  #client: Client | null = null;
  #connecting: Promise<Client> | null = null;
  #idle: ReturnType<typeof setTimeout> | undefined;
  #active = 0;
  /** Bumped on every full drop/close so an in-flight connect knows it was superseded. */
  #gen = 0;
  #closed = false;
  #dead = new WeakSet<Client>();

  constructor(private o: ConnOpts) {}

  exec = async (cmd: string, opts: ExecOpts): Promise<ExecResult> => {
    try {
      return await this.#run(cmd, opts);
    } catch (e) {
      // Retry only failures before the command could have started: re-running a
      // half-executed, non-idempotent command is worse than reporting the drop.
      // Whatever client failed has already been dropped by whoever saw it; a
      // healthy connection is never torn down for one exec's failure.
      if (this.#closed || !(e instanceof RemoteError) || e.code !== "REMOTE_UNREACHABLE" || e.started) throw e;
      await new Promise((r) => setTimeout(r, this.o.reconnectDelayMs ?? 1000));
      return await this.#run(cmd, opts);
    }
  };

  close(): void {
    this.#closed = true;
    if (this.#idle) clearTimeout(this.#idle);
    this.#drop();
  }

  #drop() {
    this.#gen++;
    const c = this.#client;
    this.#client = null;
    this.#connecting = null;
    try { c?.end(); } catch {}
  }

  /** Drop one specific client (a no-op for the shared slot if it has already been replaced). */
  #dropClient(c: Client) {
    if (this.#client === c) this.#client = null;
    try { c.end(); } catch {}
  }

  #connect(): Promise<Client> {
    if (this.#client) return Promise.resolve(this.#client);
    if (this.#connecting) return this.#connecting;
    const gen = this.#gen;
    const superseded = () => new RemoteError("REMOTE_UNREACHABLE", "connection closed");
    const p: Promise<Client> = (async () => {
      let sock: Duplex;
      try {
        sock = await this.o.socket();
      } catch (e) {
        throw new RemoteError("REMOTE_UNREACHABLE", `could not open transport: ${(e as Error).message}`);
      }
      if (gen !== this.#gen) {
        sock.destroy();
        throw superseded();
      }
      // A transport that already died (e.g. its helper process failed to start) has
      // emitted its close/error before we could listen.
      if (sock.destroyed) throw new RemoteError("REMOTE_UNREACHABLE", "transport closed before the handshake");
      const c = new Client();
      // ssh2 may emit several errors during a handshake; a listener must always exist.
      c.on("error", () => { if (this.#client === c) this.#client = null; });
      // The peer stopped sending: the session is over. Destroy so 'close' follows:
      // under Bun on Linux a socket whose FIN lands while a write is in flight emits
      // 'end' but never 'close', so ssh2 neither fails pending channel opens nor
      // lets us drop the client, and the next exec hangs on it until its timeout.
      c.on("end", () => sock.destroy());
      try {
        await new Promise<void>((resolve, reject) => {
          c.once("ready", () => resolve());
          // A transport that dies before the handshake (e.g. tailcat failed to start)
          // may never produce an ssh2 error; do not wait out readyTimeout for it.
          c.once("close", () => reject(new RemoteError("REMOTE_UNREACHABLE", "transport closed before the handshake completed")));
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
      } catch (e) {
        try { c.end(); } catch {}
        sock.destroy();
        throw e;
      }
      c.on("close", () => {
        this.#dead.add(c);
        if (this.#client === c) this.#client = null;
      });
      if (gen !== this.#gen) {
        try { c.end(); } catch {}
        throw superseded();
      }
      this.#client = c;
      return c;
    })().finally(() => {
      if (this.#connecting === p) this.#connecting = null;
    });
    this.#connecting = p;
    return p;
  }

  async #run(cmd: string, opts: ExecOpts): Promise<ExecResult> {
    if (this.#closed) throw new RemoteError("REMOTE_UNREACHABLE", "connection closed");
    // Counted from before the connect so the idle timer cannot fire mid-handshake.
    this.#active++;
    if (this.#idle) clearTimeout(this.#idle);
    try {
      const client = await this.#connect();
      return await this.#execOn(client, cmd, opts);
    } finally {
      this.#active--;
      if (this.#active === 0 && !this.#closed) {
        this.#idle = setTimeout(() => this.#drop(), this.o.idleMs ?? 10 * 60_000);
        (this.#idle as any).unref?.();
      }
    }
  }

  #execOn(client: Client, cmd: string, opts: ExecOpts): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let grace: ReturnType<typeof setTimeout> | undefined;
      let pgid: string | null = null;
      let ch: ClientChannel | null = null;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(grace);
        fn();
      };
      // The connection died under the command: not a command result, and never re-run.
      const lost = () => {
        this.#dropClient(client);
        done(() => reject(lostError()));
      };
      // Also covers opening the channel: a half-dead link must not hang the exec past timeoutMs.
      const timer = setTimeout(() => {
        timedOut = true;
        if (ch) {
          if (pgid) this.#killGroup(client, pgid);
          try { ch.close(); } catch {}
        }
        // The channel close only completes if the remote answers. If it does not,
        // the kill never arrived and we must not claim it did.
        grace = setTimeout(lost, KILL_SETTLE_MS);
      }, opts.timeoutMs);

      try {
        client.exec(wrapCommand(cmd, !!opts.login), (err, channel: ClientChannel) => {
          if (err) return done(() => reject(new RemoteError("REMOTE_UNREACHABLE", err.message)));
          if (settled || timedOut) {
            try { channel.close(); } catch {}
            return;
          }
          ch = channel;
          const out = new Capped(opts.maxOutput ?? DEFAULT_HEAD);
          const errOut = new Capped(opts.maxOutput ?? DEFAULT_HEAD);
          let pre: string | null = ""; // stderr held back until the marker line is seen
          const flushPre = () => {
            if (pre) errOut.push(pre);
            pre = null;
          };
          // Per-stream decoders: a multibyte character split across chunks must not become U+FFFD.
          const outDec = new StringDecoder("utf8");
          const errDec = new StringDecoder("utf8");
          channel.on("data", (d: Buffer) => out.push(outDec.write(d)));
          channel.stderr.on("data", (d: Buffer) => {
            const s = errDec.write(d);
            if (pre === null) return errOut.push(s);
            pre += s;
            const m = pre.match(MARKER_RE);
            if (m) {
              pgid = m[1]!;
              const rest = pre.replace(m[0], "");
              pre = null;
              if (rest) errOut.push(rest);
            } else if (pre.length > MARKER_SCAN_MAX) {
              flushPre();
            }
          });
          let code: number | null = null;
          let exited = false;
          channel.on("exit", (c: number | null) => { exited = true; code = typeof c === "number" ? c : null; });
          const finish = () => done(() => {
            const outTail = outDec.end();
            if (outTail) out.push(outTail);
            const errTail = errDec.end();
            if (errTail) { if (pre === null) errOut.push(errTail); else pre += errTail; }
            flushPre();
            const note = timedOut ? `\n[timed out after ${opts.timeoutMs}ms; process group killed]` : "";
            resolve({
              stdout: out.text(),
              stderr: errOut.text() + note,
              code: timedOut ? null : code,
              truncated: out.truncated || errOut.truncated,
              timedOut,
            });
          });
          channel.on("close", () => {
            if (settled) return;
            if (!exited && !timedOut) {
              // Channel closed without an exit status: the connection dropped
              // mid-command (laptop slept, tailcat stopped). Not a command result.
              return lost();
            }
            if (!exited && timedOut) {
              // Either our close was acknowledged or the whole connection died
              // (the client's own close event lands just after the channel's).
              setTimeout(() => (this.#dead.has(client) ? lost() : finish()), 50);
              return;
            }
            finish();
          });
          if (opts.stdin !== undefined) channel.end(opts.stdin);
          else channel.end();
        });
      } catch (e) {
        // ssh2 throws synchronously ("Not connected") when the socket is gone but
        // its close event has not landed yet.
        this.#dropClient(client);
        done(() => reject(new RemoteError("REMOTE_UNREACHABLE", (e as Error).message)));
      }
    });
  }

  /** TERM the group, KILL it after a grace period. Fire-and-forget on the same connection. */
  #killGroup(client: Client, pgid: string) {
    const kill = `kill -TERM -${pgid} 2>/dev/null; i=0; while [ $i -lt ${KILL_GRACE_S} ]; do kill -0 -${pgid} 2>/dev/null || exit 0; sleep 1; i=$((i+1)); done; kill -KILL -${pgid} 2>/dev/null; exit 0`;
    try {
      client.exec(kill, (e, ch) => { if (!e) { ch.on("data", () => {}); ch.stderr.on("data", () => {}); ch.end(); } });
    } catch {
      // Connection already gone; the exec's own settle path reports it.
    }
  }
}
