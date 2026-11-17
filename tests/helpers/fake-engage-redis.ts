import { SCRIPTS, type EngageRedis } from "../../src/gateway/engage/budget";

type Entry = { v: string; set?: Set<string>; until: number };

/**
 * The Redis commands the engage state uses, over one Map: two stores built on
 * one instance model two replicas. `eval` runs the store's scripts by identity
 * (each is atomic here because the fake has no await inside one).
 */
export function fakeEngageRedis(opts: { fail?: () => boolean; now?: () => number } = {}): EngageRedis & { data: Map<string, Entry>; evals: number } {
  const now = opts.now ?? Date.now;
  const data = new Map<string, Entry>();
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
    evals: 0,
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
    async sismember(k: string, m: string) {
      guard();
      return live(k)?.set?.has(m) ? 1 : 0;
    },
    async eval(script: string, _n: number, ...a: string[]) {
      guard();
      fake.evals++;
      const key = a[0]!;
      if (script === SCRIPTS.incrExpire) {
        const e = live(key);
        const n = Number(e?.v ?? 0) + 1;
        data.set(key, { v: String(n), until: e?.until ?? (n === 1 ? now() + Number(a[1]) * 1000 : Number.POSITIVE_INFINITY) });
        return n;
      }
      if (script === SCRIPTS.takeOne) {
        const e = live(key);
        const v = Number(e?.v);
        if (!e || !(v > 0)) return 0;
        if (v <= 1) data.delete(key);
        else e.v = String(v - 1);
        return 1;
      }
      if (script === SCRIPTS.addMember) {
        const e = live(key) ?? { v: "", set: new Set<string>(), until: now() + Number(a[2]) * 1000 };
        e.set = e.set ?? new Set();
        e.set.add(a[1]!);
        data.set(key, e);
        return 1;
      }
      throw new Error("unknown script");
    },
  };
  return fake;
}
