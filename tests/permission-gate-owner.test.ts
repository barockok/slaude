/**
 * /1on1 named guests at the permission gate: the owner-only card (only the
 * lock owner's click decides; no decision in time is a deny) and the clicker
 * check on ordinary permission cards (a card in a 1on1 thread is decided by
 * the owner or the manager, never a guest or a bystander).
 */
import { describe, expect, test } from "bun:test";
import * as PendingGates from "../src/db/pending-gates";
import { PermissionGate, ownerDecision, ownerGateId, type OwnerGateArgs } from "../src/gateway/slack/permission-gate";

type Handler = (a: any) => Promise<void>;

function fakeApp() {
  const handlers: { matcher: RegExp; fn: Handler }[] = [];
  const posts: any[] = [];
  const updates: any[] = [];
  const app: any = {
    action: (matcher: RegExp, fn: Handler) => handlers.push({ matcher, fn }),
    client: {
      chat: {
        postMessage: async (m: any) => {
          posts.push(m);
          return { ok: true, ts: `9.${posts.length}` };
        },
        update: async (m: any) => {
          updates.push(m);
          return { ok: true };
        },
      },
    },
  };
  return {
    app,
    posts,
    updates,
    fire: async (action_id: string, userId: string) => {
      const respondCalls: any[] = [];
      for (const h of handlers) {
        if (h.matcher.test(action_id)) {
          await h.fn({ ack: async () => {}, action: { action_id }, body: { user: { id: userId } }, respond: async (m: any) => respondCalls.push(m) });
        }
      }
      return respondCalls;
    },
  };
}

async function waitPosts(f: { posts: any[] }, n = 1): Promise<void> {
  for (let i = 0; i < 1000 && f.posts.length < n; i++) await new Promise((r) => setTimeout(r, 1));
  if (f.posts.length < n) throw new Error("no card posted");
}

const OWNER = "U0OWNER";
const GUEST = "U0QA";
let n = 0;
const args = (over: Partial<OwnerGateArgs> = {}): OwnerGateArgs => ({
  sessionId: "s-owner",
  toolName: "mcp__sandbox__git_push",
  input: { remote: "origin", token: "secret-value" },
  toolUseId: `tu_owner_${++n}_${Date.now()}`,
  owner: OWNER,
  guest: GUEST,
  rule: "mcp__*__git_push",
  timeoutMs: 60_000,
  ...over,
});
const settled = <T>(p: Promise<T>) => {
  let done = false;
  void p.then(() => (done = true));
  return () => done;
};

describe("PermissionGate.requestOwner (in-process, mono)", () => {
  test("card names the owner, offers no Always allow, redacts secrets; the guest's click is refused", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app, { gateBus: null });
    gate.bindSession("s-owner", "C1", "1.0");
    const a = args();
    const p = gate.requestOwner(a, new AbortController().signal);
    const isDone = settled(p);
    await waitPosts(f);

    const card = JSON.stringify(f.posts[0].blocks);
    expect(card).toContain("Owner approval needed");
    expect(card).toContain(`Only <@${OWNER}> can allow it`);
    expect(card).toContain(`<@${GUEST}> (a guest)`);
    expect(card).not.toContain("Always allow");
    expect(card).not.toContain("secret-value");
    const row = await PendingGates.get(ownerGateId(a.toolUseId));
    expect(row?.payload).toMatchObject({ approvers: [OWNER], ownerOnly: true });

    const refused = await f.fire(`slaude_perm:allow:${ownerGateId(a.toolUseId)}`, GUEST);
    expect(refused[0]).toMatchObject({ response_type: "ephemeral", replace_original: false });
    expect(refused[0].text).toContain(`only <@${OWNER}> can decide this`);
    await new Promise((r) => setTimeout(r, 10));
    expect(isDone()).toBe(false);
    expect((await PendingGates.get(ownerGateId(a.toolUseId)))?.status).toBe("pending");

    const ok = await f.fire(`slaude_perm:allow:${ownerGateId(a.toolUseId)}`, OWNER);
    expect(ok[0]).toMatchObject({ replace_original: true });
    expect(ok[0].text).toContain(`*Allowed* once by <@${OWNER}>`);
    const d = await p;
    expect(d.behavior).toBe("allow");
    expect(ownerDecision(d, a.toolName, OWNER)).toEqual({ allow: true });
    expect((await PendingGates.get(ownerGateId(a.toolUseId)))?.resolvedBy).toBe(OWNER);
  });

  test("the owner's Deny is a deny with a reason the model can relay", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app, { gateBus: null });
    gate.bindSession("s-owner", "C1", "1.0");
    const a = args();
    const p = gate.requestOwner(a, new AbortController().signal);
    await waitPosts(f);
    await f.fire(`slaude_perm:deny:${ownerGateId(a.toolUseId)}`, OWNER);
    const d = await p;
    expect(d.behavior).toBe("deny");
    const g = ownerDecision(d, a.toolName, OWNER);
    expect(g.allow).toBe(false);
    if (!g.allow) {
      expect(g.reason).toContain("OWNER_ONLY");
      expect(g.reason).toContain(`Denied by <@${OWNER}>`);
    }
  });

  test("a forged Always allow on an owner card counts once (no session rule)", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app, { gateBus: null });
    gate.bindSession("s-owner", "C1", "1.0");
    const a = args();
    const p = gate.requestOwner(a, new AbortController().signal);
    await waitPosts(f);
    const r = await f.fire(`slaude_perm:always:${ownerGateId(a.toolUseId)}`, OWNER);
    expect(r[0].text).toContain("*Allowed* once");
    const d = await p;
    expect(d).toEqual({ behavior: "allow", updatedInput: a.input });
  });

  test("no decision before the timeout is a deny; the row expires and the card says so", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app, { gateBus: null });
    gate.bindSession("s-owner", "C1", "1.0");
    const a = args({ timeoutMs: 40 });
    const d = await gate.requestOwner(a, new AbortController().signal);
    expect(d).toEqual({ behavior: "deny", message: "expired before a decision" });
    expect(ownerDecision(d, a.toolName, OWNER)).toMatchObject({ allow: false });
    expect((await PendingGates.get(ownerGateId(a.toolUseId)))?.status).toBe("expired");
    await new Promise((r) => setTimeout(r, 5));
    expect(f.updates.at(-1)?.text).toContain(`no decision from <@${OWNER}>`);
    // A late owner click finds the gate settled and changes nothing.
    const late = await f.fire(`slaude_perm:allow:${ownerGateId(a.toolUseId)}`, OWNER);
    expect(late[0].text).toContain("expired");
  });

  test("abort cancels the gate and denies", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app, { gateBus: null });
    gate.bindSession("s-owner", "C1", "1.0");
    const ac = new AbortController();
    const a = args();
    const p = gate.requestOwner(a, ac.signal);
    await waitPosts(f);
    ac.abort();
    expect(await p).toEqual({ behavior: "deny", message: "aborted" });
  });

  test("no bound thread → deny without a card", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app, { gateBus: null });
    const d = await gate.requestOwner(args({ sessionId: "unbound" }), new AbortController().signal);
    expect(d.behavior).toBe("deny");
    expect(f.posts).toHaveLength(0);
  });
});

describe("PermissionGate.openOwner (poll row, node)", () => {
  test("poll row decided only by the owner; the guest's click leaves it pending", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app, { gateBus: null });
    const a = args();
    const { pendingId } = await gate.openOwner({ ...a, channel: "C1", threadTs: "1.0" });
    expect(pendingId).toBe(ownerGateId(a.toolUseId));
    expect((await PendingGates.get(pendingId))?.payload).toMatchObject({ waiter: "poll", approvers: [OWNER], ownerOnly: true });

    const refused = await f.fire(`slaude_perm:allow:${pendingId}`, GUEST);
    expect(refused[0].text).toContain(`only <@${OWNER}> can decide this`);
    expect((await PendingGates.get(pendingId))?.status).toBe("pending");

    await f.fire(`slaude_perm:always:${pendingId}`, OWNER);
    const row = await PendingGates.get(pendingId);
    expect(row?.status).toBe("approved");
    expect(row?.resolvedBy).toBe(OWNER);
    expect((row?.payload as any).decision).toBe("allow"); // never "always" on an owner card
  });

  test("the auto-deny timer expires an undecided poll row", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app, { gateBus: null });
    const { pendingId } = await gate.openOwner({ ...args({ timeoutMs: 30 }), channel: "C1", threadTs: "1.0" });
    for (let i = 0; i < 200 && (await PendingGates.get(pendingId))?.status === "pending"; i++) await new Promise((r) => setTimeout(r, 5));
    expect((await PendingGates.get(pendingId))?.status).toBe("expired");
  });

  test("a card that never reached Slack cancels its row", async () => {
    const f = fakeApp();
    f.app.client.chat.postMessage = async () => {
      throw new Error("slack down");
    };
    const gate = new PermissionGate(f.app, { gateBus: null });
    const a = args();
    await expect(gate.openOwner({ ...a, channel: "C1", threadTs: "1.0" })).rejects.toThrow("slack down");
    expect((await PendingGates.get(ownerGateId(a.toolUseId)))?.status).toBe("cancelled");
  });
});

describe("PermissionGate clickers (ordinary cards in a 1on1 thread)", () => {
  const clickers = async (_c: string, t: string) => (t === "1on1" ? [OWNER, "U0MGR"] : null);

  test("in-process card: a guest's click is refused and the card stays; the owner decides", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app, { gateBus: null, clickers });
    gate.bindSession("s-click", "C1", "1on1");
    const id = `tu_click_${Date.now()}`;
    const p = gate.resolver("s-click", "Bash", { command: "ls" }, { toolUseID: id, signal: new AbortController().signal } as any);
    await waitPosts(f);
    expect((await PendingGates.get(id))?.payload).toMatchObject({ approvers: [OWNER, "U0MGR"] });
    const refused = await f.fire(`slaude_perm:allow:${id}`, GUEST);
    expect(refused[0]).toMatchObject({ response_type: "ephemeral" });
    expect((await PendingGates.get(id))?.status).toBe("pending");
    await f.fire(`slaude_perm:allow:${id}`, "U0MGR");
    expect((await p).behavior).toBe("allow");
  });

  test("poll card (node): same check from the row's payload", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app, { gateBus: null, clickers });
    const id = `tu_click_poll_${Date.now()}`;
    await gate.open({ sessionId: "s-click", toolName: "Bash", input: {}, toolUseId: id, channel: "C1", threadTs: "1on1" });
    await f.fire(`slaude_perm:deny:${id}`, GUEST);
    expect((await PendingGates.get(id))?.status).toBe("pending");
    await f.fire(`slaude_perm:deny:${id}`, OWNER);
    expect((await PendingGates.get(id))?.status).toBe("denied");
  });

  test("unlocked thread (clickers → null): anyone may decide, as before", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app, { gateBus: null, clickers });
    gate.bindSession("s-open", "C1", "plain");
    const id = `tu_click_plain_${Date.now()}`;
    const p = gate.resolver("s-open", "Bash", {}, { toolUseID: id, signal: new AbortController().signal } as any);
    await waitPosts(f);
    expect((await PendingGates.get(id))?.payload).not.toHaveProperty("approvers");
    await f.fire(`slaude_perm:allow:${id}`, "U0ANYONE");
    expect((await p).behavior).toBe("allow");
  });

  test("a failed clicker lookup posts no card (fail closed)", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app, {
      gateBus: null,
      clickers: async () => {
        throw new Error("db down");
      },
    });
    gate.bindSession("s-fail", "C1", "1.0");
    await expect(
      gate.resolver("s-fail", "Bash", {}, { toolUseID: `tu_fail_${Date.now()}`, signal: new AbortController().signal } as any),
    ).rejects.toThrow("could not resolve who may approve");
    expect(f.posts).toHaveLength(0);
  });
});
