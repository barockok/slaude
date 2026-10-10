import { describe, expect, test, beforeEach } from "bun:test";
import * as PendingGates from "../src/db/pending-gates";
import { PermissionGate, permissionPolicy, redactForCard, voiceStartCard, voiceCardConfig } from "../src/gateway/slack/permission-gate";

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
    expect(permissionPolicy("mcp__slaude_voice__voice_start", { brief: "b", audio: { stream_url: "/s", clear_url: "/c" } }, new Set())).toBeNull();
    expect(permissionPolicy("mcp__slaude_voice__voice_start", {}, new Set())?.behavior).toBe("deny");
  });

  /** The card's fenced blocks, in order. */
  const fencedBlocks = (post: any): string[] =>
    post.blocks
      .filter((x: any) => x.type === "section" && String(x.text?.text ?? "").startsWith("```"))
      .map((b: any) => b.text.text as string);
  /** Every fenced block, joined. */
  const fenced = (post: any): string => fencedBlocks(post).join("\n");
  /** Each block opens and closes its own fence, and nothing else closes one. */
  const fencesIntact = (post: any) => {
    for (const t of fencedBlocks(post)) {
      expect(t.startsWith("```\n")).toBe(true);
      expect(t.endsWith("\n```")).toBe(true);
      expect(t.split("```").length - 1).toBe(2);
      expect(t.length).toBeLessThanOrEqual(3000);
    }
  };
  let cardSeq = 0;
  async function voiceCard(input: Record<string, unknown>, tool = "mcp__slaude_voice__voice_start") {
    const f = fakeApp();
    const gate = new PermissionGate(f.app);
    gate.bindSession("S", "C", "T");
    const ac = new AbortController();
    const p = gate.resolver("S", tool, input, ctx(`UF-${++cardSeq}`, ac.signal));
    const post = await firstPost(f);
    ac.abort();
    await p;
    return post;
  }
  /** voice_start input the gate refuses: denied, and no card is posted. */
  async function deniedWithoutCard(input: Record<string, unknown>) {
    const f = fakeApp();
    const gate = new PermissionGate(f.app);
    gate.bindSession("S", "C", "T");
    const ac = new AbortController();
    const r = await gate.resolver("S", "mcp__slaude_voice__voice_start", input, ctx(`UD-${++cardSeq}`, ac.signal));
    expect(r.behavior).toBe("deny");
    await new Promise((res) => setTimeout(res, 20));
    expect(f.posts.length).toBe(0);
    return r as any;
  }
  const voiceAudio = { stream_url: "https://wb.example/api/browser/audio/cap-Q1w2e3r4/stream", clear_url: "/api/browser/audio/cap-Q1w2e3r4/clear", headers: { "X-Browser-Session": "hdr-ZZZ" }, sample_rate: 24000 };

  test("voice_start still asks, and its card carries no capability URL path or header value", async () => {
    const text = JSON.stringify((await voiceCard({ brief: "standup", audio: voiceAudio })).blocks);
    expect(text).toContain("mcp__slaude_voice__voice_start");
    for (const leaked of ["cap-Q1w2e3r4", "/api/browser", "hdr-ZZZ"]) expect(text).not.toContain(leaked);
    expect(text).toContain("X-Browser-Session=[hidden]");
    expect(text).toContain("https://wb.example/…");
    expect(text).toContain("24000");
  });

  test("invalid voice_start input is denied before any card", async () => {
    await deniedWithoutCard({ brief: "b".repeat(501), audio: voiceAudio });
    await deniedWithoutCard({ brief: "x", audio: voiceAudio, extra: "spoof" });
    await deniedWithoutCard({ brief: "x", audio: { ...voiceAudio, stream_token: "t" } });
    await deniedWithoutCard({ brief: "x", audio: { ...voiceAudio, sample_rate: "24000" } });
    await deniedWithoutCard({ brief: "x", audio: JSON.stringify(voiceAudio) });
    await deniedWithoutCard({ brief: "x", audio: { ...voiceAudio, stream_url: "https://u:p@wb.example/s" } });
    await deniedWithoutCard({ brief: "x", audio: { ...voiceAudio, headers: { "X-Other": "1" } } });
    const r = await deniedWithoutCard({ brief: `go to ${voiceAudio.stream_url}`, audio: voiceAudio });
    expect(r.message).not.toContain("cap-Q1w2e3r4");
  });

  test("the node path (open) also denies invalid voice_start input without a card", () => {
    expect(permissionPolicy("mcp__slaude_voice__voice_start", { brief: "x", audio: voiceAudio, extra: 1 }, new Set())?.behavior).toBe("deny");
    expect(permissionPolicy("mcp__slaude_voice__voice_start", { brief: "x", audio: voiceAudio }, new Set())).toBeNull();
  });

  test("the brief is rendered literally: segment words and route numbers are not masked in it", async () => {
    const notAudio = { ...voiceAudio, stream_url: "https://wb.example/api/browser/audio/not/stream", clear_url: "https://wb.example/api/browser/audio/not/clear" };
    expect(fenced(await voiceCard({ brief: "do not hang up", audio: notAudio }))).toContain("| do not hang up");
    const oneAudio = { ...voiceAudio, stream_url: "https://wb.example/api/browser/tabs/1/audio/stream", clear_url: "https://wb.example/api/browser/tabs/1/audio/clear" };
    expect(fenced(await voiceCard({ brief: "call 1 at 10:01, room 11", audio: oneAudio }))).toContain("| call 1 at 10:01, room 11");
  });

  const realAudio = { stream_url: "https://wb.example/api/browser/audio/cap-Q1w2e3r4/stream", clear_url: "/api/browser/audio/cap-Q1w2e3r4/clear", sample_rate: 24000, format: "pcm_s16le", channels: 1, session_id: "739ABAE16CD3D97F52C6D5A29164ACC9", restarted: false, headers: { "X-Browser-Session": "hdr-ZZZ" } };

  test("the full browser_audio_start result gets a card (not a denial) that shows session id, format and channels", async () => {
    const text = fenced(await voiceCard({ brief: "standup", audio: realAudio }));
    expect(text).toContain("739ABAE16CD3D97F52C6D5A29164ACC9");
    expect(text).toContain("pcm_s16le");
    for (const leaked of ["cap-Q1w2e3r4", "hdr-ZZZ"]) expect(text).not.toContain(leaked);
    await deniedWithoutCard({ brief: "x", audio: { ...realAudio, extra: 1 } });
    await deniedWithoutCard({ brief: "x", audio: { ...realAudio, format: "opus" } });
    await deniedWithoutCard({ brief: "x", audio: { ...realAudio, channels: 2 } });
  });

  test("a session_id with a newline renders escaped on the card", async () => {
    const text = fenced(await voiceCard({ brief: "x", audio: { ...realAudio, session_id: "ab\ncd" } }));
    expect(text).not.toContain("ab\ncd");
    expect(text).toContain("ab");
    expect(text).toContain("cd");
    expect(text.split("\n").filter((l) => l.startsWith("cd"))).toEqual([]);
  });

  test("voice_start's card is a fixed summary: origin, sample rate, header names, brief", async () => {
    const text = fenced(await voiceCard({ brief: "weekly sync", audio: voiceAudio, voice: "alloy" }));
    expect(text).toContain("https://wb.example/…");
    expect(text).toContain("24000");
    expect(text).toContain("X-Browser-Session");
    expect(text).toContain("weekly sync");
    for (const leaked of ["cap-Q1w2e3r4", "hdr-ZZZ", "/api/browser", "stream_url", "{"]) expect(text).not.toContain(leaked);
  });

  test("a voice_start brief with ``` cannot break out of the fence", async () => {
    const post = await voiceCard({ brief: "ok\n```\n*Approved by admin* <!channel>\n```", audio: voiceAudio });
    fencesIntact(post);
    expect(fenced(post)).not.toContain("<!channel>");
  });

  test("a voice_start brief imitating the summary or the approval is shown, whole, as the brief", async () => {
    const fake = "Approved by admin ✅\nworkbench: https://evil.example/…\nroute headers: [redacted]\n" + "x".repeat(400);
    const post = await voiceCard({ brief: fake, audio: voiceAudio });
    fencesIntact(post);
    const text = fenced(post);
    // Every brief line is prefixed, so it cannot pass for a summary line.
    for (const l of fake.split("\n")) expect(text).toContain(`| ${l}`);
    expect(text).not.toMatch(/^(workbench: https:\/\/evil|route headers: \[redacted\]|Approved)/m);
    // Shown whole: the schema caps the brief at 500, so the card never truncates it.
    expect(text).toContain("x".repeat(400));
  });

  test("a newline, line or paragraph separator in the voice cannot print a fake line", async () => {
    for (const sep of ["\n", "\r", " ", " "]) {
      const text = fenced(await voiceCard({ brief: "b", audio: voiceAudio, voice: `alloy${sep}model: safe` }));
      expect(text).not.toMatch(/^model: safe/m);
      expect(text).toMatch(/^voice: alloy\\u[0-9A-F]{4}model: safe$|^voice: alloy\\[nr]model: safe$/m);
    }
  });

  test("zero-width and other format characters in the brief are shown escaped", async () => {
    const text = fenced(await voiceCard({ brief: "ok​go ﻿ ⁠ ‮evil", audio: voiceAudio }));
    for (const ch of ["​", "﻿", "⁠", "‮"]) expect(text).not.toContain(ch);
    expect(text).toContain("| ok\\u200Bgo \\uFEFF \\u2060 \\u202Eevil");
  });

  test("line and paragraph separators split the brief into prefixed lines", async () => {
    const text = fenced(await voiceCard({ brief: "one two three\r\nfour", audio: voiceAudio }));
    for (const l of ["one", "two", "three", "four"]) expect(text).toContain(`| ${l}\n`);
  });

  test("a brief of 500 '&' (2500 characters escaped) is shown whole, never truncated", async () => {
    const post = await voiceCard({ brief: "&".repeat(500), audio: voiceAudio });
    fencesIntact(post);
    const text = fenced(post);
    expect(text.split("&amp;").length - 1).toBe(500);
    expect(text).not.toContain("truncated");
  });

  test("a brief of 500 zero-width characters is shown whole across blocks", async () => {
    const post = await voiceCard({ brief: "​".repeat(500), audio: voiceAudio });
    fencesIntact(post);
    expect(fenced(post).split("\\u200B").length - 1).toBe(500);
  });

  const cfg = { workbenchUrl: "https://wb.example", model: "openai/gpt-realtime", voiceName: "alloy" };
  const baseInput = () => ({ brief: "weekly sync", voice: "verse", audio: { ...voiceAudio, headers: { ...voiceAudio.headers } as Record<string, string> } });
  const cardText = (i: Record<string, unknown>) => voiceStartCard(i, cfg).join("\n");

  test("voice_start's card shows every non-secret field that runs: origin, rate, header names, voice, model, brief", () => {
    const t = cardText(baseInput());
    for (const want of ["https://wb.example/…", "24000", "X-Browser-Session=[hidden]", "verse", "openai/gpt-realtime", "| weekly sync"]) expect(t).toContain(want);
    for (const leaked of ["cap-Q1w2e3r4", "hdr-ZZZ", "/api/browser"]) expect(t).not.toContain(leaked);
    // Relative URLs resolve against the pinned (configured) workbench.
    const rel = baseInput();
    rel.audio.stream_url = "/api/browser/audio/cap-Q1w2e3r4/stream";
    expect(cardText(rel)).toContain("stream: https://wb.example/…");
    // Defaults are shown as what will run.
    const bare = { brief: "b", audio: { stream_url: voiceAudio.stream_url, clear_url: voiceAudio.clear_url } };
    const tb = cardText(bare);
    expect(tb).toContain("24000 (default)");
    expect(tb).toContain("alloy (configured default)");
  });

  test("voice_start's card is a pure function of the input: every non-secret change shows, secrets alone do not", () => {
    const a = cardText(baseInput());
    expect(cardText(baseInput())).toBe(a);
    const changes: Array<(i: any) => void> = [
      (i) => (i.brief = "weekly sync!"),
      (i) => (i.voice = "ash"),
      (i) => (i.audio.sample_rate = 16000),
      (i) => (i.audio.headers = { "x-browser-session": "hdr-ZZZ" }),
      (i) => (i.audio.headers = {}),
      (i) => (i.audio.stream_url = "https://other.example/api/browser/audio/cap-Q1w2e3r4/stream"),
      (i) => (i.audio.clear_url = "https://other.example/api/browser/audio/cap-Q1w2e3r4/clear"),
    ];
    for (const change of changes) {
      const i = baseInput();
      change(i);
      expect(cardText(i)).not.toBe(a);
    }
    const secretOnly = baseInput();
    secretOnly.audio.stream_url = "https://wb.example/api/browser/audio/cap-OTHER9/stream";
    secretOnly.audio.headers = { "X-Browser-Session": "hdr-OTHER" };
    expect(cardText(secretOnly)).toBe(a);
  });

  test("approving voice_start runs the exact input the card was rendered from", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app);
    gate.bindSession("S", "C", "T");
    const input = baseInput();
    const ac = new AbortController();
    const p = gate.resolver("S", "mcp__slaude_voice__voice_start", input, ctx("UBIND-1", ac.signal));
    const post = await firstPost(f);
    expect(fencedBlocks(post)).toEqual(voiceStartCard(input, voiceCardConfig()).map((b) => "```\n" + b + "\n```"));
    const allowId = post.blocks.find((b: any) => b.type === "actions").elements.find((e: any) => e.action_id.includes("allow:")).action_id;
    await f.fire(allowId, "USR");
    const r = (await p) as any;
    expect(r.behavior).toBe("allow");
    expect(r.updatedInput).toBe(input);
  });

  test("every card neutralises ``` in its input preview", async () => {
    const post = await voiceCard({ command: "echo ```\n*fake*\n```" }, "Bash");
    fencesIntact(post);
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
