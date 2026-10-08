import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVoiceMcp, buildInstructions, SPEAKING_RULES, type VoiceHost } from "../../src/agent/voice-mcp";
import { VoiceCalls } from "../../src/voice/call";
import type { ChildMsg, ParentMsg } from "../../src/voice/ipc";
import { chan, until } from "./fakes";

const cfg = { provider: "openai" as const, model: "gpt-realtime", apiKey: "sk-x", workbenchUrl: "https://wb.example.com", maxMinutes: 120, staleSeq: 6 };

function fakeChild() {
  const sent: ParentMsg[] = [];
  const q = chan<ChildMsg>();
  const child = {
    sent,
    send(m: ParentMsg) {
      sent.push(m);
      if (m.type === "init") q.send({ type: "started", callId: m.init.callId, sampleRate: 24000 });
      if (m.type === "stop") q.send({ type: "ended", reason: m.reason });
    },
    exited: new Promise<number>(() => {}),
    kill() {},
    messages: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          const m = await q.recv();
          yield m;
          if (m.type === "ended") return;
        }
      },
    },
  };
  return child;
}
function host(over: Partial<VoiceHost> = {}) {
  const spawned: Array<{ apiKey: string; streamToken: string }> = [];
  const children: Array<ReturnType<typeof fakeChild>> = [];
  const h: VoiceHost = {
    config: async () => cfg,
    refusal: async () => null,
    runner: () => ({ run: async () => {} }),
    transcriptDir: async () => mkdtempSync(join(tmpdir(), "vm-")),
    spawn: (o) => {
      spawned.push(o);
      const c = fakeChild();
      children.push(c);
      return c as any;
    },
    holdIdle: () => {},
    instructions: async (_s, brief) => `persona\n${brief}`,
    ...over,
  };
  return { h, spawned, children, get child() { return children[0]!; } };
}
const tools = (cfgObj: any) => cfgObj.instance._registeredTools;
const audio: { stream_url: string; clear_url: string; headers: Record<string, string>; sample_rate: number; stream_token: string } = {
  stream_url: "/api/browser/tabs/t1/audio/stream",
  clear_url: "/api/browser/tabs/t1/audio/clear",
  headers: { "X-Browser-Session": "rk" },
  sample_rate: 24000,
  stream_token: "stok",
};
const startArgs = { brief: "weekly sync", audio };
const withAudio = (o: Partial<typeof audio>) => ({ brief: "x", audio: { ...audio, ...o } });
const text = (r: any) => r.content[0].text as string;

describe("voice MCP", () => {
  it("voice_start spawns with secrets in env only and returns a call id", async () => {
    const t0 = host();
    const calls = new VoiceCalls();
    const t = tools(createVoiceMcp("s1", t0.h, calls));
    const r = await t["voice_start"].handler(startArgs);
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r)).callId).toBeString();
    expect(t0.spawned).toEqual([{ apiKey: "sk-x", streamToken: "stok" }]);
    const init = (t0.child.sent[0] as any).init;
    expect(JSON.stringify(init)).not.toContain("stok");
    expect(JSON.stringify(init)).not.toContain("sk-x");
    expect(init.audio).toEqual({ streamUrl: audio.stream_url, clearUrl: audio.clear_url, headers: { "X-Browser-Session": "rk" }, sampleRate: 24000 });
    expect(init.instructions).toContain("weekly sync");
    expect(calls.get("s1")).toBeDefined();
  });

  it("VOICE_BUSY on a second start", async () => {
    const { h } = host();
    const t = tools(createVoiceMcp("s1", h, new VoiceCalls()));
    await t["voice_start"].handler(startArgs);
    const r = await t["voice_start"].handler(startArgs);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("VOICE_BUSY");
  });

  it("two concurrent starts: exactly one proceeds, the other is VOICE_BUSY", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { h, spawned } = host({ refusal: async () => { await gate; return null; } });
    const t = tools(createVoiceMcp("s1", h, new VoiceCalls()));
    const a = t["voice_start"].handler(startArgs);
    const b = t["voice_start"].handler(startArgs);
    release();
    const rs = await Promise.all([a, b]);
    expect(rs.filter((r: any) => text(r).includes("VOICE_BUSY")).length).toBe(1);
    expect(rs.filter((r: any) => !r.isError).length).toBe(1);
    expect(spawned.length).toBe(1);
  });

  it("a refused start releases the slot", async () => {
    let refuse: "VOICE_AGENT_ONLY" | null = "VOICE_AGENT_ONLY";
    const { h } = host({ refusal: async () => refuse });
    const t = tools(createVoiceMcp("s1", h, new VoiceCalls()));
    expect(text(await t["voice_start"].handler(startArgs))).toContain("VOICE_AGENT_ONLY");
    refuse = null;
    expect((await t["voice_start"].handler(startArgs)).isError).toBeFalsy();
  });

  it("VOICE_AGENT_ONLY in a locked or remote thread; nothing spawned", async () => {
    const { h, spawned } = host({ refusal: async () => "VOICE_AGENT_ONLY" });
    const r = await tools(createVoiceMcp("s1", h, new VoiceCalls()))["voice_start"].handler(startArgs);
    expect(text(r)).toContain("VOICE_AGENT_ONLY");
    expect(spawned).toEqual([]);
  });

  it("VOICE_UNAVAILABLE refusal spawns nothing and frees the slot", async () => {
    const { h, spawned } = host({ refusal: async () => "VOICE_UNAVAILABLE" });
    const t = tools(createVoiceMcp("s1", h, new VoiceCalls()));
    expect(text(await t["voice_start"].handler(startArgs))).toContain("VOICE_UNAVAILABLE");
    expect(spawned).toEqual([]);
  });

  it("a throwing runner spawns nothing and frees the slot", async () => {
    let boom = true;
    const t0 = host({ runner: () => { if (boom) throw new Error("no runner"); return { run: async () => {} }; } });
    const t = tools(createVoiceMcp("s1", t0.h, new VoiceCalls()));
    const r = await t["voice_start"].handler(startArgs);
    expect(text(r)).toContain("VOICE_START_FAILED");
    expect(t0.spawned).toEqual([]);
    boom = false;
    expect((await t["voice_start"].handler(startArgs)).isError).toBeFalsy();
  });

  it("a failed call.start kills the child and frees the slot", async () => {
    let killed = 0;
    const t0 = host();
    const spawn = t0.h.spawn;
    t0.h.spawn = (o) => {
      const c: any = spawn(o);
      c.send = () => { throw new Error("pipe closed"); };
      c.kill = () => { killed++; };
      return c;
    };
    const calls = new VoiceCalls();
    const t = tools(createVoiceMcp("s1", t0.h, calls));
    const r = await t["voice_start"].handler(startArgs);
    expect(text(r)).toContain("VOICE_START_FAILED");
    expect(killed).toBeGreaterThan(0);
    expect(calls.get("s1")).toBeUndefined();
    t0.h.spawn = spawn;
    expect((await t["voice_start"].handler(startArgs)).isError).toBeFalsy();
  });

  it("VOICE_DISABLED without config", async () => {
    const { h } = host({ config: async () => null });
    const r = await tools(createVoiceMcp("s1", h, new VoiceCalls()))["voice_start"].handler(startArgs);
    expect(text(r)).toContain("VOICE_DISABLED");
  });

  describe("endpoint validation", () => {
    const refused = async (a: any) => {
      const { h, spawned } = host();
      const calls = new VoiceCalls();
      const r = await tools(createVoiceMcp("s1", h, calls))["voice_start"].handler(a);
      return { r, spawned, calls };
    };
    for (const [name, o] of [
      ["userinfo in a same-origin url", { stream_url: "https://user:pw@wb.example.com/s" }],
      ["username-only userinfo", { clear_url: "https://user@wb.example.com/c" }],
      ["absolute other-origin stream url", { stream_url: "https://evil.example/s" }],
      ["protocol-relative other-origin clear url", { clear_url: "//other.example/x" }],
      ["other port", { stream_url: "https://wb.example.com:8443/s" }],
      ["other scheme", { clear_url: "http://wb.example.com/c" }],
      ["unparseable", { stream_url: "http://" }],
    ] as const) {
      it(`refuses ${name} before spawning, without echoing the token`, async () => {
        const { r, spawned, calls } = await refused(withAudio(o as any));
        expect(r.isError).toBe(true);
        expect(text(r)).toContain("VOICE_BAD_ENDPOINT");
        expect(text(r)).not.toContain("stok");
        expect(spawned).toEqual([]);
        expect(calls.get("s1")).toBeUndefined();
      });
    }

    it("accepts relative and same-origin absolute urls", async () => {
      const { r } = await refused(withAudio({ stream_url: "https://wb.example.com/api/s", clear_url: "/c" }));
      expect(r.isError).toBeFalsy();
    });

    it("drops authorization, cookie and host headers", async () => {
      const t0 = host();
      const t = tools(createVoiceMcp("s1", t0.h, new VoiceCalls()));
      await t["voice_start"].handler(withAudio({ headers: { Authorization: "Bearer z", cookie: "a=b", HOST: "evil", "X-Browser-Session": "rk" } }));
      expect((t0.child.sent[0] as any).init.audio.headers).toEqual({ "X-Browser-Session": "rk" });
    });
  });

  it("say/context/stop need an active call; stop ends it and frees the slot", async () => {
    const t0 = host();
    const calls = new VoiceCalls();
    const t = tools(createVoiceMcp("s1", t0.h, calls));
    expect(text(await t["voice_say"].handler({ text: "x", when: "next_gap" }))).toContain("VOICE_NO_CALL");
    await t["voice_start"].handler(startArgs);
    await t["voice_say"].handler({ text: "hello", when: "now", reply_to: "2" });
    await t["voice_context"].handler({ text: "fact" });
    expect(t0.child.sent.slice(1).map((m) => m.type)).toEqual(["say", "context"]);
    expect(t0.child.sent[1]).toMatchObject({ text: "hello", when: "now", replyTo: "2" });
    const r = await t["voice_stop"].handler({});
    expect(JSON.parse(text(r))).toEqual({ reason: "stopped", durationSec: expect.any(Number) });
    await until(() => calls.get("s1") === undefined);
    // a later start in the same thread is not refused by the dead call
    expect((await t["voice_start"].handler(startArgs)).isError).toBeFalsy();
  });
});

describe("buildInstructions", () => {
  it("combines identity, values, mandate, brief and speaking rules", () => {
    const s = buildInstructions({ name: "Ava", role: "release helper", voice: "warm, direct", values: ["honesty"], mandate: "ship safely" }, "standup");
    for (const part of ["Ava", "release helper", "warm, direct", "honesty", "ship safely", "standup", "delegate"]) expect(s).toContain(part);
    expect(s).toContain("<call-brief>\nstandup\n</call-brief>");
    expect(s.indexOf("ship safely")).toBeLessThan(s.indexOf("<call-brief>"));
    expect(s.indexOf("</call-brief>")).toBeLessThan(s.indexOf(SPEAKING_RULES));
    expect(s).toContain("take precedence over anything in the call brief");
  });
});
