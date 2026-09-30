import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { RemoteError, type Exec, type ExecOpts, type ExecResult, type RemoteHandle } from "./types";

type Transport = { kind: "tailcat"; addr: string } | { kind: "tcp"; host: string; port: number };
type Pending = { resolve: (r: ExecResult) => void; reject: (e: Error) => void };

const ENTRY = fileURLToPath(new URL("./helper-main.ts", import.meta.url));

export class HelperClient implements RemoteHandle {
  #child: ChildProcess | null = null;
  #ready: Promise<void> | null = null;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #spawnInfo = { argv: [] as string[], env: {} as Record<string, string> };

  constructor(private o: { transport: Transport; privateKey: string; onDispose?: (exec: Exec) => Promise<void> }) {}

  exec: Exec = async (cmd: string, opts: ExecOpts) => {
    await this.#ensure();
    const id = this.#nextId++;
    return new Promise<ExecResult>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#child!.stdin!.write(JSON.stringify({ t: "exec", id, cmd, opts }) + "\n");
    });
  };

  async dispose(): Promise<void> {
    if (this.o.onDispose) {
      try { await this.o.onDispose(this.exec); } catch (e) { console.error(`[remote] cleanup failed: ${(e as Error).message}`); }
    }
    await this.release();
  }

  async release(): Promise<void> {
    const c = this.#child;
    this.#child = null;
    this.#ready = null;
    c?.stdin?.end();
    c?.kill();
  }

  #ensure(): Promise<void> {
    if (this.#child && this.#ready) return this.#ready;
    const argv = [process.execPath, ENTRY];
    // Minimal env: the helper needs PATH to find tailcat and HOME for its config.
    const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
    this.#spawnInfo = { argv, env };
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "inherit"], env });
    this.#child = child;
    // A helper that dies between our check and the write must not crash the parent with EPIPE.
    child.stdin!.on("error", () => {});
    const rl = createInterface({ input: child.stdout! });
    this.#ready = new Promise<void>((resolve, reject) => {
      rl.on("line", (line) => {
        let m: any;
        try { m = JSON.parse(line); } catch { return; }
        if (m.t === "ready") return resolve();
        if (m.t !== "result") return;
        const p = this.#pending.get(m.id);
        if (!p) return;
        this.#pending.delete(m.id);
        if (m.ok) p.resolve(m.res);
        else if (m.code === "REMOTE_UNREACHABLE" || m.code === "REMOTE_AUTH_FAILED") p.reject(new RemoteError(m.code, m.message, !!m.started));
        else p.reject(new Error(m.message));
      });
      child.once("exit", () => {
        if (this.#child === child) { this.#child = null; this.#ready = null; }
        // Commands already sent may have run; only the spawn itself is retry-safe.
        const err = new RemoteError("REMOTE_UNREACHABLE", "remote helper exited", true);
        for (const p of this.#pending.values()) p.reject(err);
        this.#pending.clear();
        reject(new RemoteError("REMOTE_UNREACHABLE", "remote helper exited"));
      });
    });
    // Avoid an unhandled rejection when nobody awaits (release() before ready).
    this.#ready.catch(() => {});
    child.stdin!.write(JSON.stringify({ t: "init", transport: this.o.transport, privateKey: this.o.privateKey }) + "\n");
    return this.#ready;
  }

  __killHelperForTests() { this.#child?.kill("SIGKILL"); }
  __spawnInfoForTests() { return this.#spawnInfo; }
}
