import { describe, expect, test, beforeEach } from "bun:test";
import { PermissionGate } from "../src/gateway/slack/permission-gate";

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
      },
    },
  };
  return {
    app,
    posts,
    fire: async (action_id: string, userId: string) => {
      const respondCalls: any[] = [];
      const respond = async (m: any) => {
        respondCalls.push(m);
      };
      const ack = async () => {};
      for (const h of handlers) {
        if (h.matcher.test(action_id)) {
          await h.fn({
            ack,
            action: { action_id },
            body: { user: { id: userId } },
            respond,
          });
        }
      }
      return respondCalls;
    },
  };
}

function ctx(toolUseID: string, signal: AbortSignal, suggestions?: any[]): any {
  return {
    toolUseID,
    signal,
    suggestions,
    decisionReason: undefined,
  };
}

beforeEach(() => {
  delete process.env.SLAUDE_AUTO_ALLOW_TOOLS;
});

describe("PermissionGate", () => {
  test("auto-allow list bypasses prompt", async () => {
    process.env.SLAUDE_AUTO_ALLOW_TOOLS = "Read,Glob";
    const f = fakeApp();
    const gate = new PermissionGate(f.app);
    const ac = new AbortController();
    const r = await gate.resolver("S", "Read", { x: 1 }, ctx("T1", ac.signal));
    expect(r.behavior).toBe("allow");
    expect(f.posts.length).toBe(0);
  });

  test("mcp__slaude_slack__* always allowed", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app);
    const ac = new AbortController();
    const r = await gate.resolver("S", "mcp__slaude_slack__reply", {}, ctx("T2", ac.signal));
    expect(r.behavior).toBe("allow");
  });

  test("mcp__slaude_surface__* always allowed (agent output path — never gate)", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app);
    const ac = new AbortController();
    for (const t of ["mcp__slaude_surface__reply", "mcp__slaude_surface__edit", "mcp__slaude_surface__upload"]) {
      const r = await gate.resolver("S", t, {}, ctx("T2", ac.signal));
      expect(r.behavior).toBe("allow");
    }
  });

  test("mcp__slaude_runtime__* always allowed", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app);
    const ac = new AbortController();
    const r = await gate.resolver("S", "mcp__slaude_runtime__reload_session", {}, ctx("T2", ac.signal));
    expect(r.behavior).toBe("allow");
  });

  test("no route bound → deny", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app);
    const ac = new AbortController();
    const r = await gate.resolver("S", "Bash", { command: "ls" }, ctx("T3", ac.signal));
    expect(r.behavior).toBe("deny");
  });

  test("allow once", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app);
    gate.bindSession("S", "C", "T");
    const ac = new AbortController();
    const promise = gate.resolver("S", "Bash", { command: "ls" }, ctx("U1", ac.signal));
    const allowId = f.posts[0].blocks
      .find((b: any) => b.type === "actions")
      .elements.find((e: any) => e.action_id.includes("allow:")).action_id;
    await f.fire(allowId, "USR");
    const r = (await promise) as any;
    expect(r.behavior).toBe("allow");
    expect(r.updatedPermissions).toBeUndefined();
  });

  test("always (no suggestions) → addRules fallback", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app);
    gate.bindSession("S", "C", "T");
    const ac = new AbortController();
    const p = gate.resolver("S", "Bash", { command: "ls" }, ctx("U2", ac.signal));
    const alwaysId = f.posts[0].blocks
      .find((b: any) => b.type === "actions")
      .elements.find((e: any) => e.action_id.includes("always:")).action_id;
    await f.fire(alwaysId, "USR");
    const r = (await p) as any;
    expect(r.behavior).toBe("allow");
    expect(r.updatedPermissions[0].type).toBe("addRules");
    expect(r.updatedPermissions[0].rules[0].toolName).toBe("Bash");
  });

  test("always (with suggestions) honors them", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app);
    gate.bindSession("S", "C", "T");
    const ac = new AbortController();
    const sugg = [{ type: "addRules", rules: [{ toolName: "Bash(ls:*)" }], behavior: "allow", destination: "session" }];
    const p = gate.resolver("S", "Bash", { command: "ls" }, ctx("U3", ac.signal, sugg as any));
    const alwaysId = f.posts[0].blocks
      .find((b: any) => b.type === "actions")
      .elements.find((e: any) => e.action_id.includes("always:")).action_id;
    await f.fire(alwaysId, "USR");
    const r = (await p) as any;
    expect(r.updatedPermissions).toEqual(sugg);
  });

  test("deny resolves with deny", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app);
    gate.bindSession("S", "C", "T");
    const ac = new AbortController();
    const p = gate.resolver("S", "Write", { file_path: "/x" }, ctx("U4", ac.signal));
    const denyId = f.posts[0].blocks
      .find((b: any) => b.type === "actions")
      .elements.find((e: any) => e.action_id.includes("deny:")).action_id;
    await f.fire(denyId, "USR");
    const r = (await p) as any;
    expect(r.behavior).toBe("deny");
  });

  test("abort signal denies", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app);
    gate.bindSession("S", "C", "T");
    const ac = new AbortController();
    const p = gate.resolver("S", "Bash", {}, ctx("U5", ac.signal));
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    const r = (await p) as any;
    expect(r.behavior).toBe("deny");
  });

  test("duplicate click after decision → already-decided respond", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app);
    gate.bindSession("S", "C", "T");
    const ac = new AbortController();
    const p = gate.resolver("S", "Bash", {}, ctx("U6", ac.signal));
    const allowId = f.posts[0].blocks
      .find((b: any) => b.type === "actions")
      .elements.find((e: any) => e.action_id.includes("allow:")).action_id;
    await f.fire(allowId, "USR");
    await p;
    const calls = await f.fire(allowId, "USR");
    expect(calls.some((c: any) => /already decided/.test(c.text))).toBe(true);
  });

  test("unbindSession + decisionReason rendered", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app);
    gate.bindSession("S", "C", "T");
    const ac = new AbortController();
    const p = gate.resolver("S", "Bash", {}, {
      toolUseID: "U7",
      signal: ac.signal,
      decisionReason: "policy says ask",
    } as any);
    expect(JSON.stringify(f.posts[0].blocks)).toContain("policy says ask");
    const denyId = f.posts[0].blocks
      .find((b: any) => b.type === "actions")
      .elements.find((e: any) => e.action_id.includes("deny:")).action_id;
    await f.fire(denyId, "USR");
    await p;
    gate.unbindSession("S");
  });
});
