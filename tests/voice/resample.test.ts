import { describe, it, expect } from "bun:test";
import { resample } from "../../src/voice/resample";

function tone(freq: number, rate: number, ms: number): Int16Array {
  const n = Math.round((rate * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(12000 * Math.sin((2 * Math.PI * freq * i) / rate));
  return out;
}
// Zero-crossing frequency estimate: crossings/2 per second.
function dominant(pcm: Int16Array, rate: number): number {
  let c = 0;
  for (let i = 1; i < pcm.length; i++) if ((pcm[i - 1]! < 0) !== (pcm[i]! < 0)) c++;
  return (c / 2) / (pcm.length / rate);
}

describe("resample", () => {
  it("is identity for equal rates", () => {
    const x = tone(440, 24000, 100);
    expect(resample(x, 24000, 24000)).toBe(x);
  });
  it("keeps length proportional and frequency stable 24k→16k", () => {
    const x = tone(440, 24000, 500);
    const y = resample(x, 24000, 16000);
    expect(y.length).toBe(Math.round(x.length * 16000 / 24000));
    expect(Math.abs(dominant(y, 16000) - 440)).toBeLessThan(10);
  });
  it("upsamples 16k→24k", () => {
    const y = resample(tone(300, 16000, 500), 16000, 24000);
    expect(Math.abs(dominant(y, 24000) - 300)).toBeLessThan(10);
  });
});
