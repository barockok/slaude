import { describe, it, expect } from "bun:test";
import { ChildPool, type ChildHandle } from "../../../src/agent/connect-broker/child-pool";

function fakeChild(): ChildHandle & { killed: boolean; credDelivered: string | null } {
  return {
    killed: false,
    credDelivered: null,
    callTool: async (tool: string, args: unknown) => ({ ok: true, tool, args }),
    deliverCred(p: string) { (this as any).credDelivered = p; },
    kill() { (this as any).killed = true; },
  };
}

describe("ChildPool", () => {
  it("spawns once per connection id and reuses", async () => {
    let spawns = 0;
    const pool = new ChildPool({ spawnChild: () => { spawns++; return fakeChild(); }, idleMs: 10_000 });
    const a = await pool.acquire("conn-1", "plaintext-cred");
    const b = await pool.acquire("conn-1", "plaintext-cred");
    expect(spawns).toBe(1);
    expect(a).toBe(b);
    expect((a as any).credDelivered).toBe("plaintext-cred");
    pool.release("conn-1"); pool.release("conn-1");
  });

  it("does not reuse across different connection ids", async () => {
    let spawns = 0;
    const pool = new ChildPool({ spawnChild: () => { spawns++; return fakeChild(); }, idleMs: 10_000 });
    await pool.acquire("conn-1", "c"); await pool.acquire("conn-2", "c");
    expect(spawns).toBe(2);
  });

  it("reaps idle children but never one with an active lease", async () => {
    const child = fakeChild();
    const pool = new ChildPool({ spawnChild: () => child, idleMs: 0 });
    await pool.acquire("conn-1", "c"); // lease held
    pool.reapIdle(Date.now() + 1000);
    expect(child.killed).toBe(false); // leased -> survives
    pool.release("conn-1");
    pool.reapIdle(Date.now() + 1000);
    expect(child.killed).toBe(true); // idle past idleMs -> reaped
  });

  it("evict kills immediately and removes from the pool", async () => {
    const child = fakeChild();
    const pool = new ChildPool({ spawnChild: () => child, idleMs: 10_000 });
    await pool.acquire("conn-1", "c");
    pool.evict("conn-1");
    expect(child.killed).toBe(true);
    expect(pool.size()).toBe(0);
  });
});
