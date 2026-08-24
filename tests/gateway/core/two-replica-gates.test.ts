import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { ApprovalGate } from "../../../src/gateway/slack/approval-gate";
import { PermissionGate } from "../../../src/gateway/slack/permission-gate";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { __resetSoulDataMemo } from "../../../src/soul/extract";
import { paths } from "../../../src/config/home";
import { db } from "../../../src/db/schema";
import * as PendingGates from "../../../src/db/pending-gates";

/**
 * The M3 hazard the adversarial critic demonstrated: two live replicas share
 * pending_gates, but the promise waiter is in-process on the replica that
 * minted the gate. A click landing on the OTHER replica must neither destroy
 * the row (the sibling would hang forever) nor pretend to decide the plan.
 * Both gates run in one test process here, so the sibling is simulated by
 * rewriting the row's instance_id to a foreign uuid — exactly what replica B
 * sees in production (a pending row whose instance id is not its own).
 */

function fakeTransport() {
  const handlers: { matcher: RegExp; fn: (a: any) => Promise<void> }[] = [];
  const posts: any[] = [];
  const t: any = {
    client: {
      chat: {
        postMessage: async (m: any) => { posts.push(m); return { ok: true, ts: "9.9" }; },
        update: async (m: any) => { posts.push({ ...m, __update: true }); return { ok: true }; },
      },
    },
    action: (matcher: RegExp, fn: any) => handlers.push({ matcher, fn }),
  };
  const fire = async (action_id: string, userId: string) => {
    const calls: any[] = [];
    for (const h of handlers) {
      if (h.matcher.test(action_id)) {
        await h.fn({ ack: async () => {}, action: { action_id }, body: { user: { id: userId } }, respond: async (m: any) => { calls.push(m); } });
      }
    }
    return calls;
  };
  return { t, posts, fire };
}

/** Make a pending row look like it was minted by a different replica. */
async function foreignize(id: string) {
  await db.run(`UPDATE pending_gates SET instance_id = 'replica-B-boot-uuid' WHERE id = ?`, [id]);
}

beforeEach(async () => {
  writeSoulFixture(WORLD);
  await db.run("DELETE FROM pending_gates");
});

afterEach(() => {
  __resetSoulDataMemo();
  try { rmSync(paths.soul, { force: true }); } catch {}
});

describe("two live replicas share pending_gates (critic repro, fixed)", () => {
  it("approver click on replica B never hangs replica A's waiter", async () => {
    const A = fakeTransport();
    const B = fakeTransport();
    const gateA = new ApprovalGate(A.t, [], { timeoutSeconds: () => 1 }); // 1s auto-deny
    new ApprovalGate(B.t, []); // replica B: same DB, no local waiter

    const p = gateA.request({ channel: "C0TEAM", threadTs: "1.0", summary: "cross-replica" });
    for (let i = 0; i < 500 && A.posts.length === 0; i++) await new Promise((r) => setTimeout(r, 1));
    const id = A.posts[0].blocks.find((b: any) => b.type === "actions").elements[0].action_id.split(":")[2];
    // Replica B sees A's row as foreign (in-process both gates share
    // INSTANCE_ID, so stamp the row with A's "other" identity explicitly).
    await foreignize(id);

    // The legitimate approver's click lands on replica B.
    const bResponds = await B.fire(`slaude_appr:approve:${id}`, "U0APP");
    // B refuses to decide a sibling's gate: buttons stay, clicker is told.
    expect(bResponds.some((r) => /another replica/.test(r.text ?? ""))).toBe(true);
    expect(bResponds.some((r) => r.replace_original === true)).toBe(false);
    expect((await PendingGates.get(id))!.status).toBe("pending");

    // A's waiter settles (auto-deny at 1s) — never hangs.
    const settled = await Promise.race([
      p.then((d) => ({ settled: true as const, d })),
      new Promise<{ settled: false }>((r) => setTimeout(() => r({ settled: false }), 3000)),
    ]);
    expect(settled.settled).toBe(true);
    if (settled.settled) {
      expect(settled.d.approved).toBe(false);
      expect(settled.d.by).toBe("system");
    }
    expect((await PendingGates.get(id))!.status).toBe("expired");
  }, 10_000);

  it("auto-deny timer still settles locally when the row was cancelled out from under it", async () => {
    const A = fakeTransport();
    const gateA = new ApprovalGate(A.t, [], { timeoutSeconds: () => 1 });
    const p = gateA.request({ channel: "C0TEAM", threadTs: "2.0", summary: "cancelled row" });
    for (let i = 0; i < 500 && A.posts.length === 0; i++) await new Promise((r) => setTimeout(r, 1));
    const id = A.posts[0].blocks.find((b: any) => b.type === "actions").elements[0].action_id.split(":")[2];
    // Simulate the historical hazard: something terminal-but-not-a-click
    // settles the row while the waiter is alive.
    await PendingGates.resolve(id, "cancelled", "someone-else");

    const settled = await Promise.race([
      p.then((d) => ({ settled: true as const, d })),
      new Promise<{ settled: false }>((r) => setTimeout(() => r({ settled: false }), 3000)),
    ]);
    expect(settled.settled).toBe(true);
    if (settled.settled) expect(settled.d.approved).toBe(false);
  }, 10_000);

  it("a click on a live waiter whose row a sweep expired delivers a local deny (never hangs)", async () => {
    const A = fakeTransport();
    const gateA = new ApprovalGate(A.t, []); // no auto-deny timer
    const p = gateA.request({ channel: "C0TEAM", threadTs: "3.0", summary: "swept row" });
    for (let i = 0; i < 500 && A.posts.length === 0; i++) await new Promise((r) => setTimeout(r, 1));
    const id = A.posts[0].blocks.find((b: any) => b.type === "actions").elements[0].action_id.split(":")[2];
    // A boot/interval sweep on some replica expires the row.
    await PendingGates.resolve(id, "expired", "system");

    const responds = await A.fire(`slaude_appr:approve:${id}`, "U0APP");
    expect(responds.some((r) => /already decided/.test(r.text ?? ""))).toBe(true);
    const d = await p;
    expect(d.approved).toBe(false);
    expect(d.by).toBe("system");
  }, 10_000);

  it("permission prompt: swept row + click denies the waiting SDK promise", async () => {
    const A = fakeTransport();
    const gate = new PermissionGate(A.t);
    gate.bindSession("S", "C0TEAM", "4.0");
    const ac = new AbortController();
    const p = gate.resolver("S", "Bash", { command: "ls" }, { toolUseID: "swept_tu", signal: ac.signal } as any);
    for (let i = 0; i < 500 && A.posts.length === 0; i++) await new Promise((r) => setTimeout(r, 1));
    await PendingGates.resolve("swept_tu", "expired", "system");

    const responds = await A.fire("slaude_perm:allow:swept_tu", "U0MGR");
    expect(responds.some((r) => /already decided/.test(r.text ?? ""))).toBe(true);
    const r = (await p) as any;
    expect(r.behavior).toBe("deny");
  }, 10_000);
});
