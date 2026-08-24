/**
 * Cross-replica gate resolution (spec §5 "Interactions across replicas"):
 *
 *   - poll-waiter rows (opened for node long-polls) settle on ANY replica;
 *   - a click on a replica WITHOUT the in-process waiter resolves the durable
 *     row and publishes gate:<id>; the sibling holding the waiter wakes via
 *     its bus subscription and delivers the SDK/approval promise;
 *   - without a bus, foreign in-process rows keep the conservative
 *     "pending on another replica" refusal (mono unchanged);
 *   - non-approver refusal and instance-stray-cancel semantics survive.
 *
 * Two gate instances share the same DB (same process) and an in-memory gate
 * bus standing in for Redis pub/sub. INSTANCE_ID is per-process, so
 * "foreign row" is simulated by clearing the row's instance_id.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as PendingGates from "../../src/db/pending-gates";
import {
  PermissionGate,
  permissionPolicy,
  autoAllowFromEnv,
  decisionFromPermRow,
} from "../../src/gateway/slack/permission-gate";
import { ApprovalGate, decisionFromApprovalRow } from "../../src/gateway/slack/approval-gate";
import { memoryGateBus } from "../../src/queue/gate-bus";

type Handler = (a: any) => Promise<void>;

function fakeApp() {
  const handlers: { matcher: RegExp; fn: Handler }[] = [];
  const posts: any[] = [];
  const app: any = {
    action: (matcher: RegExp, fn: Handler) => handlers.push({ matcher, fn }),
    client: {
      chat: {
        postMessage: async (m: any) => {
          posts.push(m);
          return { ok: true, ts: "9.9" };
        },
        update: async () => ({ ok: true }),
      },
    },
  };
  const fire = async (action_id: string, userId: string) => {
    const respondCalls: any[] = [];
    for (const h of handlers) {
      if (h.matcher.test(action_id)) {
        await h.fn({
          ack: async () => {},
          action: { action_id },
          body: { user: { id: userId } },
          respond: async (m: any) => {
            respondCalls.push(m);
          },
        });
      }
    }
    return respondCalls;
  };
  return { app, posts, fire };
}

async function markForeign(id: string): Promise<void> {
  await db.run(`UPDATE pending_gates SET instance_id = 'other-process' WHERE id = ?`, [id]);
}

const tick = () => new Promise((r) => setTimeout(r, 5));

beforeEach(async () => {
  await db.run("DELETE FROM pending_gates");
  delete process.env.SLAUDE_AUTO_ALLOW_TOOLS;
});

describe("permissionPolicy (shared node/gateway short-circuits)", () => {
  test("auto-allow, namespace allows, oauth deny, prompt fallthrough", () => {
    const allow = new Set(["Read"]);
    expect(permissionPolicy("Read", {}, allow)?.behavior).toBe("allow");
    expect(permissionPolicy("mcp__slaude_surface__reply", {}, allow)?.behavior).toBe("allow");
    expect(permissionPolicy("mcp__slaude_kb__kb_search", {}, allow)?.behavior).toBe("allow");
    expect(permissionPolicy("mcp__foo__authenticate", {}, allow)?.behavior).toBe("deny");
    expect(permissionPolicy("Bash", {}, allow)).toBeNull();
    process.env.SLAUDE_AUTO_ALLOW_TOOLS = "Bash, Grep";
    expect(autoAllowFromEnv()).toEqual(new Set(["Bash", "Grep"]));
  });
});

describe("perm gate: poll-waiter rows (node long-poll path)", () => {
  test("open() posts the card and mints a poll row; policy short-circuits skip the card", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app, { gateBus: memoryGateBus() });
    const short = await gate.open({
      sessionId: "S1", toolName: "mcp__slaude_surface__reply", input: {}, toolUseId: "puse_0",
      channel: "C1", threadTs: "1.0",
    });
    expect("decision" in short && short.decision.behavior).toBe("allow");
    expect(f.posts.length).toBe(0);

    const res = await gate.open({
      sessionId: "S1", toolName: "Bash", input: { command: "ls" }, toolUseId: "puse_1",
      channel: "C1", threadTs: "1.0", suggestions: [{ type: "addRules" }],
    });
    expect(res).toEqual({ pendingId: "puse_1" });
    expect(f.posts.length).toBe(1);
    const row = await PendingGates.get("puse_1");
    expect(row?.status).toBe("pending");
    expect((row?.payload as any).waiter).toBe("poll");
  });

  test("a click on a DIFFERENT instance settles a poll row and records the decision", async () => {
    const busA = memoryGateBus();
    const opener = new PermissionGate(fakeApp().app, { gateBus: busA });
    await opener.open({
      sessionId: "S1", toolName: "Bash", input: { command: "ls" }, toolUseId: "puse_2",
      channel: "C1", threadTs: "1.0",
    });
    await markForeign("puse_2"); // opened by another gateway replica
    let published = 0;
    const busB = memoryGateBus();
    await busB.subscribe("puse_2", () => published++);
    const clicker = fakeApp();
    new PermissionGate(clicker.app, { gateBus: busB });
    const responds = await clicker.fire("slaude_perm:always:puse_2", "U_APPROVER");
    expect(responds.some((r) => String(r.text).includes("Always-allowed"))).toBe(true);
    const row = await PendingGates.get("puse_2");
    expect(row?.status).toBe("approved");
    expect(row?.resolvedBy).toBe("U_APPROVER");
    expect((row?.payload as any).decision).toBe("always");
    expect(published).toBe(1);
    // Node-side mapping honors the recorded decision granularity.
    const d = decisionFromPermRow(row!, "Bash", { command: "ls" }, undefined) as any;
    expect(d.behavior).toBe("allow");
    expect(d.updatedPermissions?.length).toBe(1);
  });

  test("duplicate click on a settled poll row is stale", async () => {
    const opener = new PermissionGate(fakeApp().app, { gateBus: memoryGateBus() });
    await opener.open({
      sessionId: "S1", toolName: "Bash", input: {}, toolUseId: "puse_3", channel: "C1", threadTs: "1.0",
    });
    const clicker = fakeApp();
    new PermissionGate(clicker.app, { gateBus: memoryGateBus() });
    await clicker.fire("slaude_perm:deny:puse_3", "U1");
    const responds = await clicker.fire("slaude_perm:allow:puse_3", "U2");
    expect(responds.some((r) => String(r.text).includes("already decided"))).toBe(true);
    expect((await PendingGates.get("puse_3"))?.status).toBe("denied");
  });
});

describe("perm gate: cross-replica in-process waiter", () => {
  test("click on replica B resolves replica A's SDK promise via the bus", async () => {
    const bus = memoryGateBus();
    const a = fakeApp();
    const gateA = new PermissionGate(a.app, { gateBus: bus });
    gateA.bindSession("S1", "C1", "1.0");
    const ac = new AbortController();
    const promise = gateA.resolver("S1", "Bash", { command: "rm x" }, {
      toolUseID: "puse_4",
      signal: ac.signal,
      suggestions: undefined,
      decisionReason: undefined,
    } as any);
    await tick(); // let the row + card land
    await markForeign("puse_4"); // as replica B sees it: not its own row
    const b = fakeApp();
    new PermissionGate(b.app, { gateBus: bus });
    await b.fire("slaude_perm:allow:puse_4", "U_OK");
    const decision: any = await promise;
    expect(decision.behavior).toBe("allow");
    expect((await PendingGates.get("puse_4"))?.resolvedBy).toBe("U_OK");
  });

  test("without a bus, a foreign in-process row keeps the conservative refusal", async () => {
    const a = fakeApp();
    const gateA = new PermissionGate(a.app, { gateBus: null });
    gateA.bindSession("S1", "C1", "1.0");
    const ac = new AbortController();
    void gateA.resolver("S1", "Bash", {}, {
      toolUseID: "puse_5", signal: ac.signal, suggestions: undefined, decisionReason: undefined,
    } as any);
    await tick();
    await markForeign("puse_5");
    const b = fakeApp();
    new PermissionGate(b.app, { gateBus: null });
    const responds = await b.fire("slaude_perm:allow:puse_5", "U_OK");
    expect(responds.some((r) => String(r.text).includes("another replica"))).toBe(true);
    expect((await PendingGates.get("puse_5"))?.status).toBe("pending");
    ac.abort(); // clean up the parked waiter
  });

  test("own row with no waiter (abort raced the click) is still stray-cancelled", async () => {
    const a = fakeApp();
    const gateA = new PermissionGate(a.app, { gateBus: memoryGateBus() });
    gateA.bindSession("S1", "C1", "1.0");
    const ac = new AbortController();
    const p = gateA.resolver("S1", "Bash", {}, {
      toolUseID: "puse_6", signal: ac.signal, suggestions: undefined, decisionReason: undefined,
    } as any);
    await tick();
    ac.abort();
    await p;
    // Row was already cancelled by the abort listener; a click is stale.
    const responds = await a.fire("slaude_perm:allow:puse_6", "U_OK");
    expect(responds.some((r) => String(r.text).includes("already decided"))).toBe(true);
    expect((await PendingGates.get("puse_6"))?.status).toBe("cancelled");
  });
});

describe("approval gate: poll rows + cross-replica clicks", () => {
  const soulless = { timeoutSeconds: () => 0 };

  test("open() mints a poll row; a click on another instance settles it; non-approvers refused", async () => {
    const opener = fakeApp();
    const gateA = new ApprovalGate(opener.app, ["U_APPROVER"], { ...soulless, gateBus: memoryGateBus() });
    const { pendingId } = await gateA.open({ channel: "C1", threadTs: "1.0", summary: "deploy", sessionId: "S1" });
    expect(opener.posts.length).toBe(1);
    await markForeign(pendingId);
    // The allowlist rides in the payload (that's what makes ANY replica able
    // to authorize) — a full-suite run may resolve approvers from a soul
    // fixture instead of the env fallback, so read the effective list.
    const allowlist = ((await PendingGates.get(pendingId))!.payload.approvers as string[]) ?? [];
    expect(allowlist.length).toBeGreaterThan(0);
    const approver = allowlist[0]!;
    const clicker = fakeApp();
    new ApprovalGate(clicker.app, ["U_APPROVER"], { ...soulless, gateBus: memoryGateBus() });
    // Non-approver: refused, row stays pending.
    const refused = await clicker.fire(`slaude_appr:approve:${pendingId}`, "U_RANDO_NOT_LISTED");
    expect(refused.some((r) => String(r.text).includes("not on the approver allowlist"))).toBe(true);
    expect((await PendingGates.get(pendingId))?.status).toBe("pending");
    // Approver: settles.
    await clicker.fire(`slaude_appr:approve:${pendingId}`, approver);
    const row = await PendingGates.get(pendingId);
    expect(row?.status).toBe("approved");
    expect(decisionFromApprovalRow(row!)).toEqual({ approved: true, by: approver });
  });

  test("click on replica B resolves replica A's request() promise via the bus", async () => {
    const bus = memoryGateBus();
    const a = fakeApp();
    const gateA = new ApprovalGate(a.app, [], { ...soulless, gateBus: bus });
    const promise = gateA.request({ channel: "C1", threadTs: "1.0", summary: "plan", sessionId: "S1" });
    await tick();
    const id = String(a.posts[0].blocks.find((b: any) => b.type === "actions").elements[0].action_id).replace(
      "slaude_appr:approve:",
      "",
    );
    await markForeign(id);
    // Click as an allowed user — the payload allowlist may be non-empty when
    // a soul fixture from another test file resolved approvers.
    const allowlist = ((await PendingGates.get(id))!.payload.approvers as string[]) ?? [];
    const clickerId = allowlist[0] ?? "U_B";
    const b = fakeApp();
    new ApprovalGate(b.app, [], { ...soulless, gateBus: bus });
    await b.fire(`slaude_appr:deny:${id}`, clickerId);
    const d = await promise;
    expect(d).toEqual({ approved: false, by: clickerId });
  });

  test("without a bus, a foreign in-process approval keeps the refusal", async () => {
    const a = fakeApp();
    const gateA = new ApprovalGate(a.app, [], { ...soulless, gateBus: null });
    void gateA.request({ channel: "C1", threadTs: "1.0", summary: "plan", sessionId: "S1" });
    await tick();
    const id = String(a.posts[0].blocks.find((b: any) => b.type === "actions").elements[0].action_id).replace(
      "slaude_appr:approve:",
      "",
    );
    await markForeign(id);
    const b = fakeApp();
    new ApprovalGate(b.app, [], { ...soulless, gateBus: null });
    const responds = await b.fire(`slaude_appr:approve:${id}`, "U_B");
    expect(responds.some((r) => String(r.text).includes("another replica"))).toBe(true);
    expect((await PendingGates.get(id))?.status).toBe("pending");
  });
});

describe("handlePending gate-bus wake", () => {
  test("a publish wakes the long-poll before the poll interval", async () => {
    const { InMemoryPendingSource } = await import("../../src/gateway/api/pending-source");
    const { handlePending } = await import("../../src/gateway/api/pending");
    const source = new InMemoryPendingSource();
    const row = await source.create("perm", "S1", {}, Date.now() + 60_000);
    const bus = memoryGateBus();
    const started = Date.now();
    const pending = handlePending(row.id, source, {
      timeoutMs: 5_000,
      pollMs: 4_000, // poll alone would burn ~4s; the wake must beat it
      wake: (id, cb) => bus.subscribe(id, cb),
    });
    await tick();
    await source.resolve(row.id, "approved", "U_X");
    await bus.publish(row.id);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).resolvedBy).toBe("U_X");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
