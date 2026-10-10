/**
 * The REAL voice-loop child (src/voice/loop-entry.ts) spawned through
 * spawnVoiceLoop: how it ends, what it flushes first, and what it exits with.
 * Not covered here: provider_failed / parent_gone after init. The provider URL
 * is fixed inside the child (Bun's WebSocket also ignores HTTPS_PROXY), so
 * reaching those paths from a real process would hit the live provider; they
 * are covered in-process by tests/voice/loop.test.ts. The missing-credentials
 * path is in tests/voice/spawn.test.ts.
 */
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnVoiceLoop, type LoopChild } from "../../src/voice/spawn";
import { ENV_API_KEY, parseChildMsg, type ChildMsg, type VoiceInit } from "../../src/voice/ipc";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../../src/voice/loop-entry.ts", import.meta.url));

const init = (over: Partial<VoiceInit> = {}, audio: Partial<VoiceInit["audio"]> = {}): VoiceInit => ({
  callId: "c1",
  audio: { streamUrl: "https://wb.example.com/s", clearUrl: "https://wb.example.com/c", headers: {}, sampleRate: 24000, ...audio },
  audioAllowedOrigins: ["https://wb.example.com"],
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
const start = (o: { apiKey: string }) => {
  const c = spawnVoiceLoop(o);
  spawned.push(c);
  return c;
};
afterEach(() => {
  for (const c of spawned.splice(0)) c.kill();
});

describe("voice-loop child entry (real process)", () => {
  it("a first line that is not init ends loop_crashed once, flushed before exit 2", async () => {
    const child = start({ apiKey: "k" });
    child.send({ type: "context", text: "not an init" });
    const got = await drain(child);
    expect(ended(got)).toEqual([{ type: "ended", reason: "loop_crashed" }]);
    expect(got.at(-1)).toEqual({ type: "ended", reason: "loop_crashed" });
    expect(await child.exited).toBe(2);
  });

  it("a missing provider key ends loop_crashed", async () => {
    const child = start({ apiKey: "" });
    child.send({ type: "init", init: init() });
    const got = await drain(child);
    expect(ended(got)).toEqual([{ type: "ended", reason: "loop_crashed" }]);
    expect(await child.exited).toBe(2);
  });

  it("stdin closed before any line (parent died early) ends loop_crashed, exit 2", async () => {
    const proc = Bun.spawn([process.execPath, "--no-env-file", ENTRY], {
      stdin: "pipe", stdout: "pipe", stderr: "ignore",
      env: { PATH: process.env.PATH ?? "", [ENV_API_KEY]: "k" },
    });
    void proc.stdin.end();
    const lines = (await new Response(proc.stdout).text()).trim().split("\n").map((l) => parseChildMsg(l));
    expect(lines.filter((m) => m?.type === "ended")).toEqual([{ type: "ended", reason: "loop_crashed" }]);
    expect(await proc.exited).toBe(2);
  });

  it("the provider key alone is enough credentials: an off-origin endpoint ends audio_lost, never crashes", async () => {
    const child = start({ apiKey: "k" });
    child.send({ type: "init", init: init({}, { streamUrl: "https://evil.example.net/s" }) });
    const got = await drain(child);
    expect(ended(got)).toEqual([{ type: "ended", reason: "audio_lost" }]);
    expect(got.some((m) => m.type === "log" && m.level === "error" && m.message.includes("origin not allowed"))).toBe(true);
    expect(await child.exited).toBe(1);
  });
});

/** A stand-in child (a real process) that echoes the capability URL it was
 *  given on stderr and in a `log` ipc line, as a failing fetch might. */
describe("a child that echoes its capability URL (real process)", () => {
  const CAP = "cap-4d8e2f9a1b";
  const dir = mkdtempSync(join(tmpdir(), "voice-echo-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const entry = join(dir, "echo-entry.ts");
  writeFileSync(entry, `
const reader = Bun.stdin.stream().getReader();
let buf = "";
while (!buf.includes("\\n")) { const { value, done } = await reader.read(); if (done) break; buf += new TextDecoder().decode(value); }
const init = JSON.parse(buf.split("\\n")[0]).init;
const url = new URL(init.audio.streamUrl, init.audioAllowedOrigins[0]).toString();
process.stderr.write("fetch failed: " + url + "\\n");
process.stdout.write(JSON.stringify({ type: "log", level: "error", message: "fetch " + url + " failed" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "ended", reason: "audio_lost" }) + "\\n");
await Bun.sleep(50);
process.exit(1);
`);
  const echoInit = () => init({}, { streamUrl: `/api/browser/audio/${CAP}/stream`, clearUrl: `/api/browser/audio/${CAP}/clear` });

  it("a log ipc line reaches the parent with the URL masked", async () => {
    const child = spawnVoiceLoop({ apiKey: "k", entry });
    spawned.push(child);
    child.send({ type: "init", init: echoInit() });
    const got = await drain(child);
    const logs = got.filter((m) => m.type === "log");
    expect(logs.length).toBe(1);
    expect(JSON.stringify(got)).not.toContain(CAP);
    expect((logs[0] as any).message).toContain("https://wb.example.com/…");
  });

  it("a stderr line reaches the parent's stderr with the URL masked", async () => {
    const written: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: any) => { written.push(String(chunk)); return true; }) as any);
    try {
      const child = spawnVoiceLoop({ apiKey: "k", entry });
      spawned.push(child);
      child.send({ type: "init", init: echoInit() });
      await drain(child);
      await child.exited;
      await Bun.sleep(50);
    } finally {
      spy.mockRestore();
    }
    const all = written.join("");
    expect(all).toContain("fetch failed: https://wb.example.com/…");
    expect(all).not.toContain(CAP);
  });
});
