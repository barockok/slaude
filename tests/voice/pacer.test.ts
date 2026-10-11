import { describe, it, expect } from "bun:test";
import { MicPacer } from "../../src/voice/pacer";
import { virtualClock } from "./fakes";

const RATE = 24_000;
const msOf = (samples: number) => (samples * 1000) / RATE;
const chunk = (ms: number, v = 1) => new Int16Array(Math.round((RATE * ms) / 1000)).fill(v);

function setup(o: { maxBacklogMs?: number } = {}) {
  const clock = virtualClock();
  const sent: Array<{ at: number; samples: number; first: number }> = [];
  const p = new MicPacer({
    rate: RATE,
    send: (pcm) => sent.push({ at: clock.now(), samples: pcm.length, first: pcm[0] ?? 0 }),
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    ...o,
  });
  const total = () => sent.reduce((n, s) => n + s.samples, 0);
  return { clock, sent, p, total };
}

describe("MicPacer", () => {
  it("a 3 s burst delivered at once goes out over ~3 s, never faster than 1.2x real time", () => {
    // Backlog cap raised: this case is about the rate alone (the default 1 s
    // cap would drop most of an instant 3 s burst, see the next case).
    const { clock, sent, p, total } = setup({ maxBacklogMs: 5_000 });
    for (let i = 0; i < 150; i++) p.push(chunk(20)); // 3 s, all at t=0
    for (let t = 0; t <= 4_000; t += 10) clock.advanceTo(t);
    expect(msOf(total())).toBeCloseTo(3_000, 0);
    const lastAt = sent.at(-1)!.at;
    expect(lastAt).toBeGreaterThan(2_700);
    expect(lastAt).toBeLessThan(3_100);
    // Cumulative never ahead of the burst allowance plus real time, and over
    // any window from 1 s on, never above 1.2x.
    let cum = 0;
    for (const s of sent) {
      cum += s.samples;
      expect(msOf(cum)).toBeLessThanOrEqual(100 + s.at + 1);
      if (s.at >= 500) expect(msOf(cum) / s.at).toBeLessThanOrEqual(1.2 + 1e-9);
    }
    expect(p.takeStats()).toEqual({ droppedMs: 0, drops: 0 });
  });

  it("a 5 s burst drops the oldest audio and keeps the latency at 1 s or less", () => {
    const { clock, sent, p, total } = setup();
    for (let i = 0; i < 250; i++) p.push(chunk(20, i + 1)); // 5 s at t=0, chunk i holds value i+1
    for (let t = 0; t <= 3_000; t += 10) clock.advanceTo(t);
    const stats = p.takeStats();
    expect(stats.drops).toBeGreaterThan(0);
    // What went out plus what was dropped is all of it; at most burst + 1 s went out.
    expect(Math.round(msOf(total()) + stats.droppedMs)).toBe(5_000);
    expect(msOf(total())).toBeLessThanOrEqual(1_100 + 1);
    // The newest audio is kept: the last sample sent is from the last chunk,
    // and it went out within ~1 s of arriving.
    expect(sent.at(-1)!.first).toBe(250);
    expect(sent.at(-1)!.at).toBeLessThanOrEqual(1_000);
    // The oldest was dropped: the first 3.8 s never went out, past the burst.
    const firstValues = new Set(sent.map((s) => s.first));
    expect(firstValues.has(100)).toBe(false);
    // Stats reset after being taken.
    expect(p.takeStats()).toEqual({ droppedMs: 0, drops: 0 });
  });

  it("steady real-time input passes through with under 60 ms added delay", () => {
    const { clock, sent, p, total } = setup();
    const arrivals: number[] = [];
    for (let i = 0; i < 500; i++) {
      // 20 ms chunks at real time, with up to 15 ms of arrival jitter.
      const at = i * 20 + (i % 3) * 5;
      clock.advanceTo(at);
      arrivals.push(at);
      p.push(chunk(20, i + 1));
    }
    clock.advanceTo(500 * 20 + 1_000);
    expect(msOf(total())).toBeCloseTo(10_000, 0);
    for (const s of sent) {
      const arrived = arrivals[s.first - 1]!;
      expect(s.at - arrived).toBeLessThan(60);
    }
    expect(p.takeStats().drops).toBe(0);
  });

  it("close clears the queue and the timers; nothing is sent after", () => {
    const { clock, sent, p } = setup();
    for (let i = 0; i < 50; i++) p.push(chunk(20));
    expect(clock.pending()).toBeGreaterThan(0);
    const before = sent.length;
    p.close();
    expect(clock.pending()).toBe(0);
    clock.advanceTo(5_000);
    p.push(chunk(20));
    clock.advanceTo(6_000);
    expect(sent.length).toBe(before);
  });

  it("clear drops queued audio without counting it as a drop", () => {
    const { clock, sent, p } = setup();
    for (let i = 0; i < 50; i++) p.push(chunk(20));
    const before = sent.length;
    p.clear();
    clock.advanceTo(5_000);
    expect(sent.length).toBe(before);
    expect(p.takeStats().drops).toBe(0);
    p.push(chunk(20));
    expect(sent.length).toBe(before + 1);
  });
});
