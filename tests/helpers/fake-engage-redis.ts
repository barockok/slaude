import { SCRIPTS, type EngageRedis } from "../../src/gateway/engage/budget";
import { LOG_SCRIPTS, type LogRedis } from "../../src/gateway/engage/conversation-log";

type Entry = { v: string; until: number };

/**
 * The Redis commands the engage state uses, over one Map: two stores built on
 * one instance model two replicas. `eval` runs the store's scripts by identity
 * (each is atomic here because the fake has no await inside one).
 */
export function fakeEngageRedis(opts: { fail?: () => boolean; now?: () => number } = {}): EngageRedis & LogRedis & { data: Map<string, Entry>; lists: Map<string, { items: string[]; until: number }>; evals: number } {
  const now = opts.now ?? Date.now;
  const data = new Map<string, Entry>();
  const live = (k: string) => {
    const e = data.get(k);
    if (e && e.until <= now()) data.delete(k);
    return data.get(k);
  };
  const lists = new Map<string, { items: string[]; until: number }>();
  const liveList = (k: string) => {
    const l = lists.get(k);
    if (l && l.until <= now()) lists.delete(k);
    return lists.get(k);
  };
  const guard = () => {
    if (opts.fail?.()) throw new Error("redis down");
  };
  const fake: any = {
    data,
    lists,
    evals: 0,
    async lrange(k: string, a: number, b: number) {
      guard();
      const items = liveList(k)?.items ?? [];
      const from = a < 0 ? Math.max(0, items.length + a) : a;
      const to = b < 0 ? items.length + b : b;
      return items.slice(from, to + 1);
    },
    async set(k: string, v: string, ...rest: unknown[]) {
      guard();
      const ex = rest[0] === "EX" ? Number(rest[1]) : 0;
      if (rest.includes("NX") && live(k)) return null;
      data.set(k, { v, until: ex ? now() + ex * 1000 : Number.POSITIVE_INFINITY });
      return "OK";
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
      if (script === LOG_SCRIPTS.append) {
        const l = liveList(key) ?? { items: [] as string[], until: 0 };
        if (l.items.some((v) => v.startsWith(`${a[1]}|`))) return 0;
        l.items.push(a[2]!);
        if (l.items.length > Number(a[3])) l.items.splice(0, l.items.length - Number(a[3]));
        l.until = now() + Number(a[4]) * 1000;
        lists.set(key, l);
        return 1;
      }
      throw new Error("unknown script");
    },
  };
  return fake;
}
