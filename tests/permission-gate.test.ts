import { describe, expect, test, beforeEach, beforeAll, afterAll } from "bun:test";
import * as PendingGates from "../src/db/pending-gates";
import { PermissionGate, permissionPolicy, redactForCard, voiceStartCard, voiceCardConfig, turnStamp, PERM_REFUSED_TEXT } from "../src/gateway/slack/permission-gate";
import { setSoulData, __resetSoulDataMemo } from "../src/soul/extract";
import { SoulDataSchema } from "../src/soul/data";
import * as OneOnOne from "../src/db/one-on-one";
import { buildAudioPolicy } from "../src/voice/audio-acl";
import * as AuditEvents from "../src/db/audit-events";
import { flushAudits } from "../src/audit/emit";

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

/** The turn's initiator in these tests is USR, who then clicks the cards. */
const USR_TURN = { initiator: "USR", origin: "slack" as const };
const AS_USR = { turnOf: () => USR_TURN };

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
  // The gateway's audio policy (voice_start is checked against it before a card).
  const VOICE_ENV: Record<string, string> = { SLAUDE_VOICE_ENABLED: "1", SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS: "https://wb.example" };
  const prevVoiceEnv = Object.fromEntries(Object.keys(VOICE_ENV).map((k) => [k, process.env[k]]));
  const restoreVoiceEnv = () => {
    for (const [k, v] of Object.entries(prevVoiceEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  beforeAll(() => { Object.assign(process.env, VOICE_ENV); });
  afterAll(restoreVoiceEnv);
  test("auto-allow list bypasses prompt", async () => {
    process.env.SLAUDE_AUTO_ALLOW_TOOLS = "Read,Glob";
    const f = fakeApp();
    const gate = new PermissionGate(f.app, AS_USR);
    const ac = new AbortController();
    const r = await gate.resolver("S", "Read", { x: 1 }, ctx("T1", ac.signal));
    expect(r.behavior).toBe("allow");
    expect(f.posts.length).toBe(0);
  });

  test("synthesized OAuth tools are denied even with a live thread (not just fail-closed)", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app, AS_USR);
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
    const gate = new PermissionGate(f.app, AS_USR);
    const ac = new AbortController();
    const r = await gate.resolver("S", "mcp__slaude_connect__connect_mcp", { server: "x" }, ctx("T", ac.signal));
    expect(r.behavior).toBe("allow");
  });

  test("mcp__slaude_slack__* always allowed", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app, AS_USR);
    const ac = new AbortController();
    const r = await gate.resolver("S", "mcp__slaude_slack__reply", {}, ctx("T2", ac.signal));
    expect(r.behavior).toBe("allow");
  });

  test("mcp__slaude_surface__* always allowed (agent output path — never gate)", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app, AS_USR);
    const ac = new AbortController();
    for (const t of ["mcp__slaude_surface__reply", "mcp__slaude_surface__edit", "mcp__slaude_surface__upload"]) {
      const r = await gate.resolver("S", t, {}, ctx("T2", ac.signal));
      expect(r.behavior).toBe("allow");
    }
  });

  test("mcp__slaude_runtime__* always allowed", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app, AS_USR);
    const ac = new AbortController();
    const r = await gate.resolver("S", "mcp__slaude_runtime__reload_session", {}, ctx("T2", ac.signal));
    expect(r.behavior).toBe("allow");
  });

  test("mid-call voice tools are allowed without a card", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app, AS_USR);
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
    expect(permissionPolicy("mcp__slaude_voice__voice_start", { brief: "b", audio: { stream_url: "https://wb.example/s", clear_url: "https://wb.example/c", headers: { "X-Browser-Session": "k" } } }, new Set())).toBeNull();
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
    const gate = new PermissionGate(f.app, AS_USR);
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
    const gate = new PermissionGate(f.app, AS_USR);
    gate.bindSession("S", "C", "T");
    const ac = new AbortController();
    const r = await gate.resolver("S", "mcp__slaude_voice__voice_start", input, ctx(`UD-${++cardSeq}`, ac.signal));
    expect(r.behavior).toBe("deny");
    await new Promise((res) => setTimeout(res, 20));
    expect(f.posts.length).toBe(0);
    return r as any;
  }
  const voiceAudio = { stream_url: "https://wb.example/api/browser/audio/cap-Q1w2e3r4/stream", clear_url: "https://wb.example/api/browser/audio/cap-Q1w2e3r4/clear", headers: { "X-Browser-Session": "hdr-ZZZ" }, sample_rate: 24000 };

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
    const { headers: _h, ...noHeaders } = voiceAudio;
    await deniedWithoutCard({ brief: "x", audio: noHeaders });
    await deniedWithoutCard({ brief: "x", audio: { ...voiceAudio, headers: {} } });
    await deniedWithoutCard({ brief: "x", audio: { ...voiceAudio, headers: { "X-Browser-Session": "" } } });
    const r = await deniedWithoutCard({ brief: `go to ${voiceAudio.stream_url}`, audio: voiceAudio });
    expect(r.message).not.toContain("cap-Q1w2e3r4");
    // Relative, or off the gateway's audio allowlist.
    const rel = await deniedWithoutCard({ brief: "x", audio: { ...voiceAudio, clear_url: "/api/browser/audio/cap-Q1w2e3r4/clear" } });
    expect(rel.message).toStartWith("VOICE_BAD_ENDPOINT");
    const off = await deniedWithoutCard({ brief: "x", audio: { ...voiceAudio, stream_url: "https://evil.example/api/browser/audio/cap-Q1w2e3r4/stream" } });
    expect(off.message).toStartWith("VOICE_BAD_ENDPOINT");
    expect(off.message).not.toContain("cap-Q1w2e3r4");
  });

  test("voice off at the gate (no policy): voice_start is denied VOICE_DISABLED with no card", async () => {
    const input = { brief: "x", audio: voiceAudio };
    const d = permissionPolicy("mcp__slaude_voice__voice_start", input, new Set(), null);
    expect(d?.behavior).toBe("deny");
    expect((d as any).message).toStartWith("VOICE_DISABLED");
    // The node passes no policy (undefined): schema only, so a valid input asks.
    expect(permissionPolicy("mcp__slaude_voice__voice_start", input, new Set(), undefined)).toBeNull();
    const quiet = console.warn;
    console.warn = () => {};
    try {
      for (const off of [{ SLAUDE_VOICE_ENABLED: "0" }, { SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS: "" }]) {
        Object.assign(process.env, off);
        const r = await deniedWithoutCard(input);
        expect(r.message).toStartWith("VOICE_DISABLED");
        Object.assign(process.env, VOICE_ENV);
      }
    } finally {
      console.warn = quiet;
      Object.assign(process.env, VOICE_ENV);
    }
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

  const realAudio = { stream_url: "https://wb.example/api/browser/audio/cap-Q1w2e3r4/stream", clear_url: "https://wb.example/api/browser/audio/cap-Q1w2e3r4/clear", sample_rate: 24000, format: "pcm_s16le", channels: 1, session_id: "739ABAE16CD3D97F52C6D5A29164ACC9", restarted: false, headers: { "X-Browser-Session": "hdr-ZZZ" } };

  test("the full browser_audio_start result gets a card (not a denial) that shows session id, format and channels", async () => {
    const text = fenced(await voiceCard({ brief: "standup", audio: realAudio }));
    expect(text).toContain("session_id: (present)");
    expect(text).not.toContain("739ABAE16CD3D97F52C6D5A29164ACC9");
    expect(text).toContain("pcm_s16le");
    for (const leaked of ["cap-Q1w2e3r4", "hdr-ZZZ"]) expect(text).not.toContain(leaked);
    await deniedWithoutCard({ brief: "x", audio: { ...realAudio, extra: 1 } });
    await deniedWithoutCard({ brief: "x", audio: { ...realAudio, format: "opus" } });
    await deniedWithoutCard({ brief: "x", audio: { ...realAudio, channels: 2 } });
  });

  test("the card never prints the session_id value, whatever it holds", async () => {
    const text = fenced(await voiceCard({ brief: "x", audio: { ...realAudio, session_id: "ab\ncd-secretish" } }));
    expect(text).toContain("session_id: (present)");
    expect(text).not.toContain("secretish");
  });

  test("a session_id equal to a URL path segment or a header value is denied with no card", async () => {
    await deniedWithoutCard({ brief: "x", audio: { ...realAudio, session_id: "cap-Q1w2e3r4" } });
    await deniedWithoutCard({ brief: "x", audio: { ...realAudio, session_id: "hdr-ZZZ" } });
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
    const fake = "Approved by admin ✅\naudio allowlist: https://evil.example\nroute headers: [redacted]\n" + "x".repeat(400);
    const post = await voiceCard({ brief: fake, audio: voiceAudio });
    fencesIntact(post);
    const text = fenced(post);
    // Every brief line is prefixed, so it cannot pass for a summary line.
    for (const l of fake.split("\n")) expect(text).toContain(`| ${l}`);
    expect(text).not.toMatch(/^(audio allowlist: https:\/\/evil|route headers: \[redacted\]|Approved)/m);
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

  const cfg = { audio: buildAudioPolicy({ origins: "https://wb.example" }), model: "openai/gpt-realtime", voiceName: "alloy" };
  const baseInput = () => ({ brief: "weekly sync", voice: "verse", audio: { ...voiceAudio, headers: { ...voiceAudio.headers } as Record<string, string> } });
  const cardText = (i: Record<string, unknown>) => voiceStartCard(i, cfg).join("\n");

  test("voice_start's card shows every non-secret field that runs: origin, rate, header names, voice, model, brief", () => {
    const t = cardText(baseInput());
    for (const want of ["https://wb.example/…", "24000", "X-Browser-Session=[hidden]", "verse", "openai/gpt-realtime", "| weekly sync"]) expect(t).toContain(want);
    for (const leaked of ["cap-Q1w2e3r4", "hdr-ZZZ", "/api/browser"]) expect(t).not.toContain(leaked);
    expect(t).toContain("audio allowlist: https://wb.example");
    expect(t).not.toContain("refuse");
    // An origin off the allowlist, or a relative URL, is flagged, never shown in full.
    const off = baseInput();
    off.audio.stream_url = "https://other.example/api/browser/audio/cap-Q1w2e3r4/stream";
    off.audio.clear_url = "/api/browser/audio/cap-Q1w2e3r4/clear";
    const to = cardText(off);
    expect(to).toContain("stream: https://other.example/… (path hidden: capability secret) (not on the audio allowlist; voice_start will refuse it)");
    expect(to).toContain("clear: (not an absolute URL; voice_start will refuse it)");
    expect(to).not.toContain("cap-Q1w2e3r4");
    // Defaults are shown as what will run.
    const bare = { brief: "b", audio: { stream_url: voiceAudio.stream_url, clear_url: voiceAudio.clear_url } };
    const tb = cardText(bare);
    expect(tb).toContain("24000 (default)");
    expect(tb).toContain("alloy (configured default)");
  });

  test("voice_start's card shows the matched origin under a wildcard entry, and flags header policy breaches", () => {
    const wild = { ...cfg, audio: buildAudioPolicy({ origins: "https://*.example.net:8443", allowedHeaders: "X-Browser-Session, X-Route-Hint", requiredHeaders: "X-Route-Hint" }) };
    const i = baseInput();
    i.audio.stream_url = "https://a.b.example.net:8443/p/cap-Q1w2e3r4/stream";
    i.audio.clear_url = "https://a.b.example.net:8443/p/cap-Q1w2e3r4/clear?k=SIG-1";
    i.audio.headers = { "X-Browser-Session": "hdr-ZZZ", "X-Other": "o-1" };
    const t = voiceStartCard(i, wild).join("\n");
    expect(t).toContain("stream: https://a.b.example.net:8443/… (path hidden: capability secret)\n");
    expect(t).toContain("audio allowlist: https://*.example.net:8443");
    expect(t).toContain("X-Other=[hidden] (not allowed; voice_start will refuse it)");
    expect(t).toContain("missing required route header: x-route-hint (voice_start will refuse it)");
    for (const leaked of ["cap-Q1w2e3r4", "SIG-1", "hdr-ZZZ", "o-1", "/p/"]) expect(t).not.toContain(leaked);
    // No policy configured: the card says so.
    expect(voiceStartCard(baseInput(), { ...cfg, audio: null }).join("\n")).toContain("audio allowlist: (not configured; voice_start will refuse it)");
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
    const gate = new PermissionGate(f.app, AS_USR);
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
    const gate = new PermissionGate(f.app, AS_USR);
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
    const gate = new PermissionGate(f.app, AS_USR);
    const ac = new AbortController();
    const r = await gate.resolver("S", "Bash", { command: "ls" }, ctx("T3", ac.signal));
    expect(r.behavior).toBe("deny");
  });

  test("allow once", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app, AS_USR);
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
    const gate = new PermissionGate(f.app, AS_USR);
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
    const gate = new PermissionGate(f.app, AS_USR);
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
    const gate = new PermissionGate(f.app, AS_USR);
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
    const gate = new PermissionGate(f.app, AS_USR);
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
    const gate = new PermissionGate(f.app, AS_USR);
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
    const gate = new PermissionGate(f.app, AS_USR);
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
    const gate = new PermissionGate(f.app, AS_USR);
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

  describe("audit", () => {
    // Audit writes are fire-and-forget, some behind a guarded resolve: poll
    // until the expected count lands (or a short deadline passes).
    async function auditRows(sessionId: string, want = 1) {
      for (let i = 0; ; i++) {
        await flushAudits();
        const items = (await AuditEvents.list({ sessionId, action: "gate.permission." })).items;
        if (items.length >= want || i >= 200) return items;
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    async function buttonId(f: { posts: any[] }, verb: string): Promise<string> {
      return (await firstPost(f)).blocks
        .find((b: any) => b.type === "actions")
        .elements.find((e: any) => e.action_id.includes(`${verb}:`)).action_id;
    }

    test("a click records gate.permission.decided with the clicker, tool and redacted input", async () => {
      const f = fakeApp();
      const gate = new PermissionGate(f.app, AS_USR);
      gate.bindSession("SAUD1", "C", "T");
      const ac = new AbortController();
      const p = gate.resolver("SAUD1", "Bash", { command: "ls", token: "hunter2" }, ctx("UA1", ac.signal));
      await f.fire(await buttonId(f, "always"), "USR");
      await p;
      const [ev, ...rest] = await auditRows("SAUD1");
      expect(rest).toHaveLength(0);
      expect(ev).toMatchObject({
        action: "gate.permission.decided",
        decision: "always",
        actorKind: "slack_user",
        actorId: "USR",
        targetKind: "tool",
        targetId: "Bash",
        persona: "default",
        channelId: "C",
        threadTs: "T",
      });
      expect((ev!.details as any).input.command).toBe("ls");
      expect(JSON.stringify(ev!.details)).not.toContain("hunter2");
    });

    test("the persona bound with the session is stamped into the row and used, with no session lookup", async () => {
      const f = fakeApp();
      const gate = new PermissionGate(f.app, AS_USR);
      gate.bindSession("SAUDP", "C", "T", undefined, "helper");
      const ac = new AbortController();
      const p = gate.resolver("SAUDP", "Bash", {}, ctx("UAP", ac.signal));
      expect((await PendingGates.get("UAP"))!.payload.personaName).toBe("helper");
      await f.fire(await buttonId(f, "allow"), "USR");
      await p;
      const r = await gate.open({ sessionId: "SAUDP", toolName: "Read", input: {}, toolUseId: "UAP2", channel: "C", threadTs: "T", persona: "helper", turn: USR_TURN });
      expect("pendingId" in r).toBe(true);
      await f.fire("slaude_perm:deny:UAP2", "USR");
      const rows = await auditRows("SAUDP", 2);
      expect(rows.map((e) => e.persona)).toEqual(["helper", "helper"]);
    });

    test("deny records decision deny; a duplicate click records nothing more", async () => {
      const f = fakeApp();
      const gate = new PermissionGate(f.app, AS_USR);
      gate.bindSession("SAUD2", "C", "T");
      const ac = new AbortController();
      const p = gate.resolver("SAUD2", "Write", {}, ctx("UA2", ac.signal));
      const id = await buttonId(f, "deny");
      await f.fire(id, "USR");
      await p;
      await f.fire(id, "USR");
      await flushAudits();
      const rows = await auditRows("SAUD2");
      expect(rows.map((r) => [r.action, r.decision])).toEqual([["gate.permission.decided", "deny"]]);
    });

    test("an abort records gate.permission.cancelled by system", async () => {
      const f = fakeApp();
      const gate = new PermissionGate(f.app, AS_USR);
      gate.bindSession("SAUD3", "C", "T");
      const ac = new AbortController();
      const p = gate.resolver("SAUD3", "Bash", {}, ctx("UA3", ac.signal));
      await firstPost(f);
      ac.abort();
      await p;
      const [ev] = await auditRows("SAUD3");
      expect(ev).toMatchObject({ action: "gate.permission.cancelled", decision: "cancelled", actorKind: "system", targetId: "Bash" });
    });

    test("a failed card post records gate.permission.cancelled", async () => {
      const f = fakeApp();
      f.app.client.chat.postMessage = async () => {
        throw new Error("slack down");
      };
      const gate = new PermissionGate(f.app, AS_USR);
      gate.bindSession("SAUD4", "C", "T");
      const ac = new AbortController();
      await expect(gate.resolver("SAUD4", "Bash", {}, ctx("UA4", ac.signal))).rejects.toThrow("slack down");
      const [ev] = await auditRows("SAUD4");
      expect(ev).toMatchObject({ action: "gate.permission.cancelled", decision: "cancelled" });
      expect((ev!.details as any).reason).toBe("card post failed");
    });

    test("the node path: a failed post on open records cancelled, a click on a poll row records decided", async () => {
      const f = fakeApp();
      const gate = new PermissionGate(f.app, AS_USR);
      const r = await gate.open({ sessionId: "SAUD5", toolName: "Bash", input: {}, toolUseId: "UA5", channel: "C", threadTs: "T", turn: USR_TURN });
      expect("pendingId" in r).toBe(true);
      await f.fire("slaude_perm:allow:UA5", "USR");
      f.app.client.chat.postMessage = async () => {
        throw new Error("slack down");
      };
      await expect(
        gate.open({ sessionId: "SAUD5", toolName: "Read", input: {}, toolUseId: "UA6", channel: "C", threadTs: "T" }),
      ).rejects.toThrow("slack down");
      const rows = await auditRows("SAUD5", 2);
      expect(rows.map((e) => [e.action, e.targetId, e.decision]).sort()).toEqual([
        ["gate.permission.cancelled", "Read", "cancelled"],
        ["gate.permission.decided", "Bash", "allow"],
      ]);
    });
  });

  describe("who may decide (click authorisation)", () => {
    beforeAll(() => {
      setSoulData(SoulDataSchema.parse({
        manager: { userId: "UMGR" },
        approvers: [{ userId: "UAPPROVER", scope: "anything", catchall: true }],
      }));
    });
    afterAll(() => __resetSoulDataMemo());

    const slackTurn = (initiator: string) => ({ turnOf: () => turnStamp(initiator, "slack") });
    async function refusals(sessionId: string, want = 1) {
      for (let i = 0; ; i++) {
        await flushAudits();
        const items = (await AuditEvents.list({ sessionId, action: "gate.permission.refused" })).items;
        if (items.length >= want || i >= 200) return items;
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    const tick = () => new Promise((r) => setTimeout(r, 10));

    test("turnStamp: only a Slack turn has an initiator", () => {
      expect(turnStamp("UALICE", "slack")).toEqual({ initiator: "UALICE", origin: "slack" });
      expect(turnStamp("UALICE", "cron")).toEqual({ initiator: null, origin: "cron" });
      expect(turnStamp("operator@example.com", "panel")).toEqual({ initiator: null, origin: "panel" });
      expect(turnStamp("UALICE", undefined)).toEqual({ initiator: null });
    });

    test("the initiator and origin are stamped into the row", async () => {
      const f = fakeApp();
      const gate = new PermissionGate(f.app, slackTurn("UALICE"));
      gate.bindSession("SAZ0", "CTEAM", "T");
      const ac = new AbortController();
      const p = gate.resolver("SAZ0", "Bash", {}, ctx("AZ0", ac.signal));
      await firstPost(f);
      expect((await PendingGates.get("AZ0"))!.payload).toMatchObject({ initiator: "UALICE", origin: "slack" });
      ac.abort();
      await p;
    });

    test("a non-initiator click is refused: row pending, waiter unresolved, refusal audited; the initiator then decides", async () => {
      const f = fakeApp();
      const gate = new PermissionGate(f.app, slackTurn("UALICE"));
      gate.bindSession("SAZ1", "CTEAM", "T");
      const ac = new AbortController();
      let settled = false;
      const p = gate.resolver("SAZ1", "Bash", { command: "ls" }, ctx("AZ1", ac.signal)).then((r) => { settled = true; return r; });
      await firstPost(f);
      const calls = await f.fire("slaude_perm:allow:AZ1", "UBOB");
      expect(calls).toEqual([{ response_type: "ephemeral", replace_original: false, text: PERM_REFUSED_TEXT }]);
      await tick();
      expect(settled).toBe(false);
      expect((await PendingGates.get("AZ1"))!.status).toBe("pending");
      const [ev, ...rest] = await refusals("SAZ1");
      expect(rest).toHaveLength(0);
      expect(ev).toMatchObject({
        action: "gate.permission.refused",
        decision: "refused",
        actorKind: "slack_user",
        actorId: "UBOB",
        targetKind: "tool",
        targetId: "Bash",
      });
      await f.fire("slaude_perm:allow:AZ1", "UALICE");
      expect(((await p) as any).behavior).toBe("allow");
      expect((await PendingGates.get("AZ1"))!.resolvedBy).toBe("UALICE");
    });

    test("the manager decides a card someone else asked for", async () => {
      const f = fakeApp();
      const gate = new PermissionGate(f.app, slackTurn("UALICE"));
      gate.bindSession("SAZ2", "CTEAM", "T");
      const ac = new AbortController();
      const p = gate.resolver("SAZ2", "Bash", {}, ctx("AZ2", ac.signal));
      await firstPost(f);
      await f.fire("slaude_perm:deny:AZ2", "UMGR");
      expect(((await p) as any).message).toBe("Denied by <@UMGR>");
    });

    test("the thread's /1on1 lock owner decides", async () => {
      await OneOnOne.lock({ channelId: "CTEAM", threadTs: "TLOCK", lockedUser: "UOWNER", createdBy: "UOWNER" });
      try {
        const f = fakeApp();
        const gate = new PermissionGate(f.app, slackTurn("UALICE"));
        gate.bindSession("SAZ3", "CTEAM", "TLOCK");
        const ac = new AbortController();
        const p = gate.resolver("SAZ3", "Bash", {}, ctx("AZ3", ac.signal));
        await firstPost(f);
        await f.fire("slaude_perm:allow:AZ3", "UOWNER");
        expect(((await p) as any).behavior).toBe("allow");
      } finally {
        await OneOnOne.unlock("CTEAM", "TLOCK");
      }
    });

    test("a cron turn has no initiator: its creator (a member) is refused, an approver decides", async () => {
      const f = fakeApp();
      const gate = new PermissionGate(f.app, { turnOf: () => turnStamp("UALICE", "cron") });
      gate.bindSession("SAZ4", "CTEAM", "T");
      const ac = new AbortController();
      let settled = false;
      const p = gate.resolver("SAZ4", "Bash", {}, ctx("AZ4", ac.signal)).then((r) => { settled = true; return r; });
      await firstPost(f);
      expect((await PendingGates.get("AZ4"))!.payload).toMatchObject({ initiator: null, origin: "cron" });
      const calls = await f.fire("slaude_perm:allow:AZ4", "UALICE");
      expect(calls[0].text).toBe(PERM_REFUSED_TEXT);
      await tick();
      expect(settled).toBe(false);
      expect((await PendingGates.get("AZ4"))!.status).toBe("pending");
      await f.fire("slaude_perm:allow:AZ4", "UAPPROVER");
      expect(((await p) as any).behavior).toBe("allow");
    });

    test("the node poll-row path enforces the same rule", async () => {
      const f = fakeApp();
      const gate = new PermissionGate(f.app);
      const r = await gate.open({
        sessionId: "SAZ5", toolName: "Bash", input: {}, toolUseId: "AZ5", channel: "CTEAM", threadTs: "T",
        turn: turnStamp("UALICE", "slack"),
      });
      expect("pendingId" in r).toBe(true);
      expect((await PendingGates.get("AZ5"))!.payload).toMatchObject({ waiter: "poll", initiator: "UALICE", origin: "slack" });
      const calls = await f.fire("slaude_perm:allow:AZ5", "UBOB");
      expect(calls).toEqual([{ response_type: "ephemeral", replace_original: false, text: PERM_REFUSED_TEXT }]);
      expect((await PendingGates.get("AZ5"))!.status).toBe("pending");
      expect(await refusals("SAZ5")).toHaveLength(1);
      await f.fire("slaude_perm:allow:AZ5", "UALICE");
      const row = (await PendingGates.get("AZ5"))!;
      expect(row.status).toBe("approved");
      expect(row.resolvedBy).toBe("UALICE");
    });

    test("a panel-origin poll row needs an approver", async () => {
      const f = fakeApp();
      const gate = new PermissionGate(f.app);
      await gate.open({
        sessionId: "SAZ6", toolName: "Bash", input: {}, toolUseId: "AZ6", channel: "CTEAM", threadTs: "T",
        turn: turnStamp("operator@example.com", "panel"),
      });
      await f.fire("slaude_perm:allow:AZ6", "UBOB");
      expect((await PendingGates.get("AZ6"))!.status).toBe("pending");
      await f.fire("slaude_perm:deny:AZ6", "UAPPROVER");
      expect((await PendingGates.get("AZ6"))!.status).toBe("denied");
    });

    test("a row written before the initiator stamp (no key) is treated as no initiator", async () => {
      const f = fakeApp();
      new PermissionGate(f.app);
      await PendingGates.create({
        id: "AZ7", kind: "perm", sessionId: "SAZ7",
        payload: { toolName: "Bash", channel: "CTEAM", threadTs: "T", waiter: "poll" },
        expiresAt: Date.now() + 60_000,
      });
      await f.fire("slaude_perm:allow:AZ7", "UALICE");
      expect((await PendingGates.get("AZ7"))!.status).toBe("pending");
      await f.fire("slaude_perm:allow:AZ7", "UMGR");
      expect((await PendingGates.get("AZ7"))!.status).toBe("approved");
    });
  });
});
