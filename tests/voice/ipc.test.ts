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
  it("parses child messages including workbench end reasons", () => {
    expect(parseChildMsg('{"type":"ended","reason":"workbench:tab_closed"}')).toEqual({ type: "ended", reason: "workbench:tab_closed" });
    expect(parseChildMsg('{"type":"ended","reason":"workbench:tab_closed2"}')).toEqual({ type: "ended", reason: "workbench:tab_closed2" });
    expect(parseChildMsg('{"type":"ended","reason":"workbench:Tab-Closed"}')).toBeNull();
    expect(parseChildMsg('{"type":"ended","reason":"bogus"}')).toBeNull();
    expect(parseChildMsg('{"type":"delegate","id":"1","task":"t","asOf":0}')).toEqual({ type: "delegate", id: "1", task: "t", asOf: 0 });
  });
  it("formats transcript lines with role and text", () => {
    expect(transcriptLine("user", "hello")).toBe("participant: hello");
    expect(transcriptLine("assistant", "hi there")).toBe("voice: hi there");
  });
});
