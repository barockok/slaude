import { describe, it, expect } from "bun:test";
import { encodeMsg, readLines, parseParentMsg, parseChildMsg, transcriptLine } from "../../src/voice/ipc";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { for (const s of chunks) c.enqueue(enc.encode(s)); c.close(); } });
}

describe("ipc", () => {
  it("encodes one JSON line per message", () => {
    expect(encodeMsg({ type: "context", text: "hi" })).toBe('{"type":"context","text":"hi"}\n');
  });
  it("reassembles lines split across chunks", async () => {
    const out: string[] = [];
    for await (const l of readLines(streamOf(['{"a":', '1}\n{"b"', ':2}\n', '{"c":3}']))) out.push(l);
    expect(out).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });
  it("parses valid parent messages and rejects junk", () => {
    expect(parseParentMsg('{"type":"say","text":"x","when":"now","asOf":3}')).toEqual({ type: "say", text: "x", when: "now", asOf: 3 });
    expect(parseParentMsg('{"type":"say","text":"x","when":"later","asOf":3}')).toBeNull();
    expect(parseParentMsg("not json")).toBeNull();
  });
  it("accepts every voice provider id in init and rejects unknown ones", () => {
    const init = {
      callId: "c1", audio: { streamUrl: "s", clearUrl: "c", headers: {}, sampleRate: 24000 },
      audioAllowedOrigins: ["https://wb.example.com"], instructions: "", provider: "openai-live", model: "gpt-live-1",
      maxMinutes: 10, staleSeq: 6,
    };
    for (const provider of ["openai", "openai-live", "gemini"]) {
      expect(parseParentMsg(JSON.stringify({ type: "init", init: { ...init, provider } }))).not.toBeNull();
    }
    expect(parseParentMsg(JSON.stringify({ type: "init", init: { ...init, provider: "nope" } }))).toBeNull();
  });

  it("parses child messages including audio provider end reasons", () => {
    expect(parseChildMsg('{"type":"ended","reason":"audio:tab_closed"}')).toEqual({ type: "ended", reason: "audio:tab_closed" });
    expect(parseChildMsg('{"type":"ended","reason":"audio:tab_closed2"}')).toEqual({ type: "ended", reason: "audio:tab_closed2" });
    expect(parseChildMsg('{"type":"ended","reason":"audio:Tab-Closed"}')).toBeNull();
    expect(parseChildMsg('{"type":"ended","reason":"workbench:tab_closed"}')).toBeNull();
    expect(parseChildMsg('{"type":"ended","reason":"bogus"}')).toBeNull();
    expect(parseChildMsg('{"type":"delegate","id":"1","task":"t","asOf":0}')).toEqual({ type: "delegate", id: "1", task: "t", asOf: 0 });
  });
  it("formats transcript lines with role and text", () => {
    expect(transcriptLine("user", "hello")).toBe("participant: hello");
    expect(transcriptLine("assistant", "hi there")).toBe("voice: hi there");
  });
});
