import { describe, it, expect, spyOn } from "bun:test";
import { spawnVoiceLoop, childEnv } from "../../src/voice/spawn";
import { ENV_API_KEY, ENV_STREAM_TOKEN, type ChildMsg } from "../../src/voice/ipc";

describe("spawnVoiceLoop", () => {
  it("child env is minimal: PATH, HOME and the two secrets only", () => {
    const env = childEnv({ apiKey: "k", streamToken: "t" });
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH", ENV_API_KEY, ENV_STREAM_TOKEN].sort());
    expect(env[ENV_API_KEY]).toBe("k");
    expect(env[ENV_STREAM_TOKEN]).toBe("t");
  });

  it("passes proxy and CA variables through only when set, nothing else", () => {
    const env = childEnv({ apiKey: "k", streamToken: "t" }, {
      PATH: "/bin", HOME: "/h", HTTPS_PROXY: "http://proxy.example.com:3128", no_proxy: "localhost",
      NODE_EXTRA_CA_CERTS: "/ca.pem", SSL_CERT_FILE: "/cert.pem", ANTHROPIC_API_KEY: "secret", SLACK_BOT_TOKEN: "secret",
    });
    expect(Object.keys(env).sort()).toEqual(
      ["HOME", "PATH", "HTTPS_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", ENV_API_KEY, ENV_STREAM_TOKEN].sort(),
    );
    expect(env.HTTPS_PROXY).toBe("http://proxy.example.com:3128");
  });

  it("a spawn failure settles exited and ends messages without throwing", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    const child = spawnVoiceLoop({ apiKey: "k", streamToken: "t", execPath: "/nonexistent/bun-voice-test" });
    expect(await child.exited).toBe(1);
    const got: ChildMsg[] = [];
    for await (const m of child.messages) got.push(m);
    expect(got).toEqual([]);
    child.send({ type: "stop", reason: "stopped" });
    child.kill();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("a child without credentials ends loop_crashed and exits 2", async () => {
    const child = spawnVoiceLoop({ apiKey: "", streamToken: "" });
    child.send({ type: "init", init: { callId: "c", audio: { streamUrl: "/s", clearUrl: "/c", headers: {}, sampleRate: 24000 },
      workbenchUrl: "https://wb.example.com", instructions: "x", provider: "openai", model: "m", maxMinutes: 1, staleSeq: 6 } });
    const got: ChildMsg[] = [];
    for await (const m of child.messages) got.push(m);
    expect(got.at(-1)).toEqual({ type: "ended", reason: "loop_crashed" });
    expect(await child.exited).toBe(2);
  });
});
