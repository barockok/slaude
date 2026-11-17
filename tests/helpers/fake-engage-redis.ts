import type { EngageRedis } from "../../src/gateway/engage/budget";

/** The few Redis commands the engage state uses, over one Map: two stores built on one instance model two replicas. */
export function fakeEngageRedis(opts: { fail?: () => boolean; now?: () => number } = {}): EngageRedis & { data: Map<string, { v: string; until: number }> } {
  const now = opts.now ?? Date.now;
  const data = new Map<string, { v: string; until: number }>();
  const live = (k: string) => {
    const e = data.get(k);
    if (e && e.until <= now()) data.delete(k);
    return data.get(k);
  };
  const guard = () => {
    if (opts.fail?.()) throw new Error("redis down");
  };
  const fake: any = {
    data,
    async get(k: string) {
      guard();
      return live(k)?.v ?? null;
    },
    async set(k: string, v: string, ...rest: unknown[]) {
      guard();
      const ex = rest[0] === "EX" ? Number(rest[1]) : 0;
      if (rest.includes("NX") && live(k)) return null;
      data.set(k, { v, until: ex ? now() + ex * 1000 : Number.POSITIVE_INFINITY });
      return "OK";
    },
    async del(...ks: string[]) {
      guard();
      for (const k of ks) data.delete(k);
      return ks.length;
    },
    async incr(k: string) {
      guard();
      const n = Number(live(k)?.v ?? 0) + 1;
      data.set(k, { v: String(n), until: live(k)?.until ?? Number.POSITIVE_INFINITY });
      return n;
    },
    async decr(k: string) {
      guard();
      const n = Number(live(k)?.v ?? 0) - 1;
      data.set(k, { v: String(n), until: live(k)?.until ?? Number.POSITIVE_INFINITY });
      return n;
    },
    async expire(k: string, s: number) {
      guard();
      const e = live(k);
      if (e) e.until = now() + s * 1000;
      return e ? 1 : 0;
    },
  };
  return fake;
}
