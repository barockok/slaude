import { describe, it, expect, spyOn } from "bun:test";
import { spawnVoiceLoop, childEnv, boundedLines } from "../../src/voice/spawn";
import * as ipc from "../../src/voice/ipc";
import { ENV_API_KEY, type ChildMsg } from "../../src/voice/ipc";

describe("spawnVoiceLoop", () => {
  it("child env is minimal: PATH, HOME and the provider key only", () => {
    const env = childEnv({ apiKey: "k" });
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH", ENV_API_KEY].sort());
    expect(env[ENV_API_KEY]).toBe("k");
  });

  it("there is no stream-token env variable any more", () => {
    expect(Object.keys(ipc)).not.toContain("ENV_STREAM_TOKEN");
    expect(Object.keys(childEnv({ apiKey: "k" }, { PATH: "/bin", HOME: "/h", SLAUDE_VOICE_LOOP_STREAM_TOKEN: "t" }))).not.toContain("SLAUDE_VOICE_LOOP_STREAM_TOKEN");
  });

  it("passes proxy and CA variables through only when set, nothing else", () => {
    const env = childEnv({ apiKey: "k" }, {
      PATH: "/bin", HOME: "/h", HTTPS_PROXY: "http://proxy.example.com:3128", no_proxy: "localhost",
      NODE_EXTRA_CA_CERTS: "/ca.pem", SSL_CERT_FILE: "/cert.pem", ANTHROPIC_API_KEY: "secret", SLACK_BOT_TOKEN: "secret",
    });
    expect(Object.keys(env).sort()).toEqual(
      ["HOME", "PATH", "HTTPS_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", ENV_API_KEY].sort(),
    );
    expect(env.HTTPS_PROXY).toBe("http://proxy.example.com:3128");
  });

  it("a spawn failure settles exited and ends messages without throwing", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    const child = spawnVoiceLoop({ apiKey: "k", execPath: "/nonexistent/bun-voice-test" });
    expect(await child.exited).toBe(1);
    const got: ChildMsg[] = [];
    for await (const m of child.messages) got.push(m);
    expect(got).toEqual([]);
    child.send({ type: "stop", reason: "stopped" });
    child.kill();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("a child without the provider key ends loop_crashed and exits 2", async () => {
    const child = spawnVoiceLoop({ apiKey: "" });
    child.send({ type: "init", init: { callId: "c", audio: { streamUrl: "https://wb.example.com/s", clearUrl: "https://wb.example.com/c", headers: {}, sampleRate: 24000 },
      audioAllowedOrigins: ["https://wb.example.com"], instructions: "x", provider: "openai", model: "m", maxMinutes: 1, staleSeq: 6 } });
    const got: ChildMsg[] = [];
    for await (const m of child.messages) got.push(m);
    expect(got.at(-1)).toEqual({ type: "ended", reason: "loop_crashed" });
    expect(await child.exited).toBe(2);
  });
});

describe("boundedLines (child stderr)", () => {
  const streamOf = (...chunks: string[]) => new ReadableStream<Uint8Array>({
    start(c) { for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch)); c.close(); },
  });
  const collect = async (s: ReadableStream<Uint8Array>, max: number) => {
    const out: string[] = [];
    for await (const l of boundedLines(s, max)) out.push(l);
    return out;
  };
  it("splits lines and keeps leading indentation", async () => {
    expect(await collect(streamOf("a\n  at f (x)\n", "tail"), 100)).toEqual(["a", "  at f (x)", "tail"]);
  });
  it("an over-long line is flushed truncated at a word break, and the rest of it is dropped", async () => {
    const long = "error near " + "Z".repeat(500);
    const out = await collect(streamOf(long.slice(0, 200), long.slice(200) + "\nnext\n"), 64);
    expect(out).toEqual(["error near …(truncated)", "next"]);
  });
  it("an over-long line with no word break yields only the marker", async () => {
    const out = await collect(streamOf("Q".repeat(300) + "\nok\n"), 64);
    expect(out).toEqual(["…(truncated)", "ok"]);
  });
});
