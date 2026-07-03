import { describe, expect, test } from "bun:test";
import { CHUNK_BYTES, Framer, SAMPLE_RATE } from "../src/voice/pcm";

describe("voice pcm framing", () => {
  test("constants: 80ms of s16le mono 16k", () => {
    expect(SAMPLE_RATE).toBe(16000);
    expect(CHUNK_BYTES).toBe(2560);
  });

  test("buffers until a full frame is available", () => {
    const f = new Framer();
    expect(f.push(Buffer.alloc(1000))).toEqual([]);
    expect(f.pending).toBe(1000);
    const frames = f.push(Buffer.alloc(1560));
    expect(frames.length).toBe(1);
    expect(frames[0]!.length).toBe(CHUNK_BYTES);
    expect(f.pending).toBe(0);
  });

  test("emits multiple frames from one large push, keeps remainder", () => {
    const f = new Framer();
    const frames = f.push(Buffer.alloc(CHUNK_BYTES * 2 + 880));
    expect(frames.length).toBe(2);
    expect(f.pending).toBe(880);
  });

  test("preserves byte order across fragmented pushes", () => {
    const f = new Framer(4);
    const seq = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const frames = [
      ...f.push(seq.subarray(0, 3)),
      ...f.push(seq.subarray(3, 5)),
      ...f.push(seq.subarray(5)),
    ];
    expect(frames.length).toBe(2);
    expect(Buffer.concat(frames)).toEqual(seq.subarray(0, 8));
    expect(f.pending).toBe(1);
  });

  test("exact frame-sized push passes straight through", () => {
    const f = new Framer();
    const frames = f.push(Buffer.alloc(CHUNK_BYTES));
    expect(frames.length).toBe(1);
    expect(f.pending).toBe(0);
  });
});
