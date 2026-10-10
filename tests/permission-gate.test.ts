import { describe, expect, test, beforeEach } from "bun:test";
import * as PendingGates from "../src/db/pending-gates";
import { PermissionGate, permissionPolicy, redactForCard } from "../src/gateway/slack/permission-gate";

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
          return { ok: true, ts: "9.9" };
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

// The resolver now writes the durable pending_gates row before posting the
// prompt, so the Block Kit message lands a few microtasks after the resolver
// is called — wait for it instead of reading posts[0] synchronously.
async function firstPost(f: { posts: any[] }): Promise<any> {
  for (let i = 0; i < 500 && f.posts.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
  if (f.posts.length === 0) throw new Error("no prompt posted");
  return f.posts[0];
}

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

  test("synthesized OAuth tools are denied even with a live thread (not just fail-closed)", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app);
    gate.bindSession("S", "C1", "1.0"); // live route — would otherwise prompt for approval
    const ac = new AbortController();
    for (const t of [
      "mcp__workbench__authenticate",
      "mcp__composio__complete_authentication",
      "mcp__some_server__authenticate",
    ]) {
      const r = await gate.resolver("S", t, {}, ctx("T", ac.signal));
      expect(r.behavior).toBe("deny");
    }
    expect(f.posts.length).toBe(0); // never prompts the user
  });

  test("mcp__slaude_connect__* always allowed (our deterministic connect path)", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app);
    const ac = new AbortController();
    const r = await gate.resolver("S", "mcp__slaude_connect__connect_mcp", { server: "x" }, ctx("T", ac.signal));
    expect(r.behavior).toBe("allow");
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

  test("mid-call voice tools are allowed without a card", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app);
    gate.bindSession("S", "C", "T");
    const ac = new AbortController();
    for (const t of ["mcp__slaude_voice__voice_say", "mcp__slaude_voice__voice_context", "mcp__slaude_voice__voice_stop"]) {
      const r = await gate.resolver("S", t, { text: "x" }, ctx("TV", ac.signal));
      expect(r.behavior).toBe("allow");
    }
    expect(f.posts.length).toBe(0);
  });

  test("permissionPolicy (shared by gateway and node): mid-call voice tools allowed, voice_start asks", () => {
    for (const t of ["voice_say", "voice_context", "voice_stop"]) {
      expect(permissionPolicy(`mcp__slaude_voice__${t}`, {}, new Set())?.behavior).toBe("allow");
    }
    expect(permissionPolicy("mcp__slaude_voice__voice_start", {}, new Set())).toBeNull();
  });

  test("voice_start still asks, and its card carries no capability URL path or header value", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app);
    gate.bindSession("S", "C", "T");
    const ac = new AbortController();
    const p = gate.resolver(
      "S",
      "mcp__slaude_voice__voice_start",
      {
        brief: "standup",
        audio: {
          stream_url: "https://wb.example/api/browser/audio/cap-AAA/stream",
          clear_url: "/api/browser/audio/cap-BBB/clear",
          headers: { "x-route": "hdr-EEE" },
          sample_rate: 24000,
        },
      },
      ctx("UV", ac.signal),
    );
    const text = JSON.stringify((await firstPost(f)).blocks);
    expect(text).toContain("mcp__slaude_voice__voice_start");
    for (const leaked of ["cap-AAA", "cap-BBB", "/api/browser", "hdr-EEE"]) expect(text).not.toContain(leaked);
    expect(text).toContain("x-route");
    expect(text).toContain("https://wb.example/…");
    expect(text).toContain("24000");
    ac.abort();
    expect((await p).behavior).toBe("deny");
  });

  test("voice_start with a JSON-string audio still shows no capability URL on the card", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app);
    gate.bindSession("S", "C", "T");
    const ac = new AbortController();
    const p = gate.resolver(
      "S",
      "mcp__slaude_voice__voice_start",
      {
        brief: "standup",
        audio: JSON.stringify({ stream_url: "https://wb.example/api/browser/audio/cap-JS1abc/stream", clear_url: "/api/browser/audio/cap-JS1abc/clear", headers: {} }),
      },
      ctx("UJ", ac.signal),
    );
    const text = JSON.stringify((await firstPost(f)).blocks);
    expect(text).toContain("mcp__slaude_voice__voice_start");
    expect(text).not.toContain("cap-JS1abc");
    expect(text).toContain("https://wb.example/…");
    ac.abort();
    await p;
  });

  test("redactForCard keeps only the origin of stream_url/clear_url and any *_url under audio", () => {
    const out = redactForCard({
      stream_url: "https://wb.example/p/cap-1/stream",
      nested: { clear_url: "https://wb.example:8443/p/cap-2/clear?k=v" },
      audio: { meet_url: "https://wb.example/p/cap-3", relative_url: "/p/cap-4", sample_rate: 24000 },
      other_url: "https://docs.example/page",
    }) as any;
    expect(out.stream_url).toBe("https://wb.example/…");
    expect(out.nested.clear_url).toBe("https://wb.example:8443/…");
    expect(out.audio.meet_url).toBe("https://wb.example/…");
    expect(out.audio.relative_url).toBe("[redacted]");
    expect(out.audio.sample_rate).toBe(24000);
    expect(out.other_url).toBe("https://docs.example/page");
  });

  test("approval card redacts token/secret/key/password values, nested too", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app);
    gate.bindSession("S", "C", "T");
    const ac = new AbortController();
    const p = gate.resolver(
      "S",
      "mcp__other__tool",
      {
        access_token: "tok-AAA",
        endpoints: { apiKey: "key-BBB", nested: { "x-secret": "sec-CCC" } },
        list: [{ password: "pw-DDD" }],
        url: "https://wb.example/x",
      },
      ctx("UR", ac.signal),
    );
    const text = JSON.stringify((await firstPost(f)).blocks);
    for (const leaked of ["tok-AAA", "key-BBB", "sec-CCC", "pw-DDD"]) expect(text).not.toContain(leaked);
    expect(text).toContain("[redacted]");
    expect(text).toContain("https://wb.example/x");
    ac.abort();
    await p;
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
    const allowId = (await firstPost(f)).blocks
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
    const alwaysId = (await firstPost(f)).blocks
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
    const alwaysId = (await firstPost(f)).blocks
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
    const denyId = (await firstPost(f)).blocks
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
    const allowId = (await firstPost(f)).blocks
      .find((b: any) => b.type === "actions")
      .elements.find((e: any) => e.action_id.includes("allow:")).action_id;
    await f.fire(allowId, "USR");
    await p;
    const updatesBefore = f.updates.length;
    const calls = await f.fire(allowId, "USR");
    const note = calls.find((c: any) => /already decided/.test(c.text));
    expect(note).toBeTruthy();
    // Leave the decided card untouched: ephemeral, no replace, no chat.update.
    expect(note.replace_original).toBe(false);
    expect(note.response_type).toBe("ephemeral");
    expect(note.blocks).toBeUndefined();
    expect(f.updates.length).toBe(updatesBefore);
  });

  test("click on a cancelled row says cancelled, not decided", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app);
    gate.bindSession("S", "C", "T");
    const ac = new AbortController();
    const p = gate.resolver("S", "Bash", {}, ctx("UCXL1", ac.signal));
    const allowId = (await firstPost(f)).blocks
      .find((b: any) => b.type === "actions")
      .elements.find((e: any) => e.action_id.includes("allow:")).action_id;
    await PendingGates.resolve("UCXL1", "cancelled", "system");
    const calls = await f.fire(allowId, "USR");
    expect(calls[0].text).toContain("cancelled");
    expect(calls[0].text).not.toContain("already decided");
    expect(calls[0].replace_original).toBe(false);
    expect(f.updates.length).toBe(0);
    expect((await p).behavior).toBe("deny");
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
    expect(JSON.stringify((await firstPost(f)).blocks)).toContain("policy says ask");
    const denyId = (await firstPost(f)).blocks
      .find((b: any) => b.type === "actions")
      .elements.find((e: any) => e.action_id.includes("deny:")).action_id;
    await f.fire(denyId, "USR");
    await p;
    gate.unbindSession("S");
  });
});
