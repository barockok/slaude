import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { RemoteError, type Exec, type ExecOpts, type ExecResult, type RemoteHandle } from "./types";

type Transport = { kind: "tailcat"; addr: string } | { kind: "tcp"; host: string; port: number };
type Pending = { resolve: (r: ExecResult) => void; reject: (e: Error) => void };
/** Everything belonging to one helper process; a late event of an old child can only touch its own. */
type Helper = { child: ChildProcess; ready: Promise<void>; pending: Map<number, Pending> };

const ENTRY = fileURLToPath(new URL("./helper-main.ts", import.meta.url));

export class HelperClient implements RemoteHandle {
  #cur: Helper | null = null;
  #all = new Set<Helper>();
  #nextId = 1;
  #spawnInfo = { argv: [] as string[], env: {} as Record<string, string> };

  constructor(private o: { transport: Transport; privateKey: string; onDispose?: (exec: Exec) => Promise<void> }) {}

  exec: Exec = async (cmd: string, opts: ExecOpts) => {
    const h = this.#ensure();
    await h.ready;
    // release()/dispose() or a helper exit may have landed while we awaited.
    if (this.#cur !== h || h.child.exitCode !== null || h.child.killed || !h.child.stdin?.writable) {
      throw new RemoteError("REMOTE_UNREACHABLE", "remote helper is not running");
    }
    const id = this.#nextId++;
    return new Promise<ExecResult>((resolve, reject) => {
      h.pending.set(id, { resolve, reject });
      try {
        h.child.stdin!.write(JSON.stringify({ t: "exec", id, cmd, opts }) + "\n");
      } catch (e) {
        h.pending.delete(id);
        reject(new RemoteError("REMOTE_UNREACHABLE", (e as Error).message));
      }
    });
  };

  async dispose(): Promise<void> {
    if (this.o.onDispose) {
      try { await this.o.onDispose(this.exec); } catch (e) { console.error(`[remote] cleanup failed: ${(e as Error).message}`); }
    }
    await this.release();
  }

  async release(): Promise<void> {
    const h = this.#cur;
    this.#cur = null;
    h?.child.stdin?.end();
    h?.child.kill();
  }

  #ensure(): Helper {
    if (this.#cur) return this.#cur;
    const argv = [process.execPath, ENTRY];
    // Minimal env: the helper needs PATH to find tailcat and HOME for its config.
    const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
    this.#spawnInfo = { argv, env };
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "inherit"], env });
    // A helper that dies between our check and the write must not crash the parent with EPIPE.
    child.stdin!.on("error", () => {});
    const pending = new Map<number, Pending>();
    const rl = createInterface({ input: child.stdout! });
    const ready = new Promise<void>((resolve, reject) => {
      rl.on("line", (line) => {
        let m: any;
        try { m = JSON.parse(line); } catch { return; }
        if (m.t === "ready") return resolve();
        if (m.t !== "result") return;
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.ok) p.resolve(m.res);
        else if (m.code === "REMOTE_UNREACHABLE" || m.code === "REMOTE_AUTH_FAILED") p.reject(new RemoteError(m.code, m.message, !!m.started));
        else p.reject(new Error(m.message));
      });
      child.once("exit", () => {
        if (this.#cur === h) this.#cur = null;
        this.#all.delete(h);
        // Commands already sent may have run; only the spawn itself is retry-safe.
        const err = new RemoteError("REMOTE_UNREACHABLE", "remote helper exited", true);
        for (const p of pending.values()) p.reject(err);
        pending.clear();
        reject(new RemoteError("REMOTE_UNREACHABLE", "remote helper exited"));
      });
    });
    // Avoid an unhandled rejection when nobody awaits (release() before ready).
    ready.catch(() => {});
    const h: Helper = { child, ready, pending };
    this.#cur = h;
    this.#all.add(h);
    child.stdin!.write(JSON.stringify({ t: "init", transport: this.o.transport, privateKey: this.o.privateKey }) + "\n");
    return h;
  }

  __killHelperForTests() { this.#cur?.child.kill("SIGKILL"); }
  __spawnInfoForTests() { return this.#spawnInfo; }
  __childForTests() { return this.#cur?.child ?? null; }
  __pendingCountForTests() { let n = 0; for (const h of this.#all) n += h.pending.size; return n; }
}
