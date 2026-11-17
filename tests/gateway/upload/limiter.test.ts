import { describe, expect, test } from "bun:test";
import { localUploadLimiter, redisUploadLimiter } from "../../../src/gateway/upload/limiter";

const fakeRedis = (o: { incr?: (k: string) => Promise<number>; expire?: (k: string, s: number) => Promise<number> }) => o as any;

describe("redisUploadLimiter", () => {
  test("counts through Redis, ten a minute", async () => {
    let n = 0;
    const l = redisUploadLimiter(fakeRedis({ incr: async () => ++n, expire: async () => 1 }), "p", localUploadLimiter());
    for (let i = 0; i < 10; i++) expect(await l.take("S")).toBe(true);
    expect(await l.take("S")).toBe(false);
  });

  test("a Redis that never answers falls back to the local limiter after the timeout", async () => {
    const never = () => new Promise<number>(() => {});
    const fixed = () => 1_800_000_000_000;
    const l = redisUploadLimiter(fakeRedis({ incr: never, expire: never }), "p", localUploadLimiter(fixed), fixed, 10, 20);
    const t = Date.now();
    expect(await l.take("S")).toBe(true);
    expect(Date.now() - t).toBeLessThan(1000);
    for (let i = 0; i < 9; i++) await l.take("S");
    expect(await l.take("S")).toBe(false); // the local count applies
  });

  test("an INCR that succeeds with EXPIRE failing still counts once", async () => {
    let n = 0;
    const l = redisUploadLimiter(fakeRedis({ incr: async () => ++n, expire: async () => { throw new Error("boom"); } }), "p", localUploadLimiter(), Date.now, 2);
    expect(await l.take("S")).toBe(true);
    expect(await l.take("S")).toBe(true);
    expect(await l.take("S")).toBe(false);
    expect(n).toBe(3);
  });

  test("an INCR error falls back to the local limiter", async () => {
    const l = redisUploadLimiter(fakeRedis({ incr: async () => { throw new Error("down"); } }), "p", localUploadLimiter(Date.now, 1), Date.now, 1);
    expect(await l.take("S")).toBe(true);
    expect(await l.take("S")).toBe(false);
  });
});
