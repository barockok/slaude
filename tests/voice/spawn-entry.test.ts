/**
 * The REAL voice-loop child (src/voice/loop-entry.ts) spawned through
 * spawnVoiceLoop: how it ends, what it flushes first, and what it exits with.
 * Not covered here: provider_failed / parent_gone after init. The provider URL
 * is fixed inside the child (Bun's WebSocket also ignores HTTPS_PROXY), so
 * reaching those paths from a real process would hit the live provider; they
 * are covered in-process by tests/voice/loop.test.ts. The missing-credentials
 * path is in tests/voice/spawn.test.ts.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { spawnVoiceLoop, type LoopChild } from "../../src/voice/spawn";
import { ENV_API_KEY, ENV_STREAM_TOKEN, parseChildMsg, type ChildMsg, type VoiceInit } from "../../src/voice/ipc";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../../src/voice/loop-entry.ts", import.meta.url));

const init = (over: Partial<VoiceInit> = {}, audio: Partial<VoiceInit["audio"]> = {}): VoiceInit => ({
  callId: "c1",
  audio: { streamUrl: "/s", clearUrl: "/c", headers: {}, sampleRate: 24000, ...audio },
  workbenchUrl: "https://wb.example.com",
  instructions: "x",
  provider: "openai",
  model: "m",
  maxMinutes: 1,
  staleSeq: 6,
  ...over,
});

async function drain(child: LoopChild): Promise<ChildMsg[]> {
  const got: ChildMsg[] = [];
  for await (const m of child.messages) got.push(m);
  return got;
}
const ended = (got: ChildMsg[]) => got.filter((m) => m.type === "ended");

const spawned: LoopChild[] = [];
const start = (o: { apiKey: string; streamToken: string }) => {
  const c = spawnVoiceLoop(o);
  spawned.push(c);
  return c;
};
afterEach(() => {
  for (const c of spawned.splice(0)) c.kill();
});

describe("voice-loop child entry (real process)", () => {
  it("a first line that is not init ends loop_crashed once, flushed before exit 2", async () => {
    const child = start({ apiKey: "k", streamToken: "t" });
    child.send({ type: "context", text: "not an init" });
    const got = await drain(child);
    expect(ended(got)).toEqual([{ type: "ended", reason: "loop_crashed" }]);
    expect(got.at(-1)).toEqual({ type: "ended", reason: "loop_crashed" });
    expect(await child.exited).toBe(2);
  });

  it("only one of the two credentials missing still ends loop_crashed", async () => {
    const child = start({ apiKey: "k", streamToken: "" });
    child.send({ type: "init", init: init() });
    const got = await drain(child);
    expect(ended(got)).toEqual([{ type: "ended", reason: "loop_crashed" }]);
    expect(await child.exited).toBe(2);
  });

  it("stdin closed before any line (parent died early) ends loop_crashed, exit 2", async () => {
    const proc = Bun.spawn([process.execPath, "--no-env-file", ENTRY], {
      stdin: "pipe", stdout: "pipe", stderr: "ignore",
      env: { PATH: process.env.PATH ?? "", [ENV_API_KEY]: "k", [ENV_STREAM_TOKEN]: "t" },
    });
    void proc.stdin.end();
    const lines = (await new Response(proc.stdout).text()).trim().split("\n").map((l) => parseChildMsg(l));
    expect(lines.filter((m) => m?.type === "ended")).toEqual([{ type: "ended", reason: "loop_crashed" }]);
    expect(await proc.exited).toBe(2);
  });

  it("an audio endpoint off the workbench origin ends audio_lost, never crashes", async () => {
    const child = start({ apiKey: "k", streamToken: "t" });
    child.send({ type: "init", init: init({}, { streamUrl: "https://evil.example.net/s" }) });
    const got = await drain(child);
    expect(ended(got)).toEqual([{ type: "ended", reason: "audio_lost" }]);
    expect(got.some((m) => m.type === "log" && m.level === "error" && m.message.includes("origin mismatch"))).toBe(true);
    expect(await child.exited).toBe(1);
  });
});
