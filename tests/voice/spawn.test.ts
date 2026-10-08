import { describe, it, expect } from "bun:test";
import { spawnVoiceLoop, childEnv } from "../../src/voice/spawn";
import { ENV_API_KEY, ENV_STREAM_TOKEN, type ChildMsg } from "../../src/voice/ipc";

describe("spawnVoiceLoop", () => {
  it("child env is minimal: PATH, HOME and the two secrets only", () => {
    const env = childEnv({ apiKey: "k", streamToken: "t" });
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH", ENV_API_KEY, ENV_STREAM_TOKEN].sort());
    expect(env[ENV_API_KEY]).toBe("k");
    expect(env[ENV_STREAM_TOKEN]).toBe("t");
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
