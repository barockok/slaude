/** A live vendor MCP child the broker talks to as an MCP client. */
export type ChildHandle = {
  callTool: (tool: string, args: unknown) => Promise<unknown>;
  /** Deliver the decrypted credential via stdin/handshake (never argv/env). */
  deliverCred: (plaintext: string) => void;
  kill: () => void;
};

type Entry = { child: ChildHandle; lease: number; lastUsed: number };

export type ChildPoolOpts = {
  spawnChild: (connectionId: string) => ChildHandle;
  idleMs: number;
};

export class ChildPool {
  #entries = new Map<string, Entry>();
  #spawn: ChildPoolOpts["spawnChild"];
  #idleMs: number;

  constructor(opts: ChildPoolOpts) {
    this.#spawn = opts.spawnChild;
    this.#idleMs = opts.idleMs;
  }

  /** Get (or spawn) the child for a connection and take a lease. Delivers the cred on first spawn. */
  async acquire(connectionId: string, credPlaintext: string): Promise<ChildHandle> {
    let e = this.#entries.get(connectionId);
    if (!e) {
      const child = this.#spawn(connectionId);
      child.deliverCred(credPlaintext);
      e = { child, lease: 0, lastUsed: Date.now() };
      this.#entries.set(connectionId, e);
    }
    e.lease++;
    e.lastUsed = Date.now();
    return e.child;
  }

  /** Release a lease. Idle children are torn down later by reapIdle. */
  release(connectionId: string): void {
    const e = this.#entries.get(connectionId);
    if (!e) return;
    e.lease = Math.max(0, e.lease - 1);
    e.lastUsed = Date.now();
  }

  /** Kill the child for a connection immediately (e.g. on revoke/expiry). */
  evict(connectionId: string): void {
    const e = this.#entries.get(connectionId);
    if (!e) return;
    e.child.kill();
    this.#entries.delete(connectionId);
  }

  /** Reap children idle past idleMs with no active lease. `now` injectable for tests. */
  reapIdle(now: number = Date.now()): void {
    for (const [id, e] of this.#entries) {
      if (e.lease > 0) continue;
      if (now - e.lastUsed >= this.#idleMs) {
        e.child.kill();
        this.#entries.delete(id);
      }
    }
  }

  size(): number {
    return this.#entries.size;
  }
}
