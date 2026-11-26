/**
 * A small in-memory stand-in for the Redis commands the box registry code
 * uses: strings with a TTL, GETDEL, MGET, EXISTS, DEL, SCAN and a MULTI that
 * runs its commands in order. Enough for unit tests of src/queue/registry.ts
 * without SLAUDE_REDIS_TEST_URL; the Redis-gated suites cover the real server.
 */
type Entry = { value: string; until: number | null };

export interface MemRedis {
  now: number;
  advance(ms: number): void;
  dump(): Record<string, string>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string | number, ...rest: Array<string | number>): Promise<"OK" | null>;
  getdel(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  exists(...keys: string[]): Promise<number>;
  mget(...keys: string[]): Promise<Array<string | null>>;
  scan(cursor: string, match: string, pattern: string, count?: string, n?: number): Promise<[string, string[]]>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  multi(): MemMulti;
}

export interface MemMulti {
  set(key: string, value: string | number, ...rest: Array<string | number>): MemMulti;
  del(...keys: string[]): MemMulti;
  sadd(key: string, ...members: string[]): MemMulti;
  srem(key: string, ...members: string[]): MemMulti;
  exec(): Promise<Array<[null, unknown]>>;
}

export function memRedis(start = 1_000_000): MemRedis {
  const strings = new Map<string, Entry>();
  const sets = new Map<string, Set<string>>();
  const live = (key: string): Entry | undefined => {
    const e = strings.get(key);
    if (e && e.until !== null && e.until <= r.now) {
      strings.delete(key);
      return undefined;
    }
    return e;
  };
  const r: MemRedis = {
    now: start,
    advance(ms) {
      r.now += ms;
    },
    dump() {
      const out: Record<string, string> = {};
      for (const k of [...strings.keys()].sort()) {
        const e = live(k);
        if (e) out[k] = e.value;
      }
      return out;
    },
    async get(key) {
      return live(key)?.value ?? null;
    },
    async set(key, value, ...rest) {
      let until: number | null = null;
      let nx = false;
      for (let i = 0; i < rest.length; i++) {
        const a = String(rest[i]).toUpperCase();
        if (a === "PX") until = r.now + Number(rest[++i]);
        else if (a === "EX") until = r.now + Number(rest[++i]) * 1000;
        else if (a === "NX") nx = true;
      }
      if (nx && live(key)) return null;
      strings.set(key, { value: String(value), until });
      return "OK";
    },
    async getdel(key) {
      const v = live(key)?.value ?? null;
      strings.delete(key);
      return v;
    },
    async del(...keys) {
      let n = 0;
      for (const k of keys) {
        if (live(k)) n++;
        strings.delete(k);
        if (sets.delete(k)) n++;
      }
      return n;
    },
    async exists(...keys) {
      return keys.filter((k) => live(k) || sets.has(k)).length;
    },
    async mget(...keys) {
      return keys.map((k) => live(k)?.value ?? null);
    },
    async scan(_cursor, _match, pattern) {
      const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
      return ["0", [...strings.keys()].filter((k) => k.startsWith(prefix) && live(k)).sort()];
    },
    async sadd(key, ...members) {
      const s = sets.get(key) ?? new Set<string>();
      sets.set(key, s);
      let n = 0;
      for (const m of members) if (!s.has(m)) (s.add(m), n++);
      return n;
    },
    async srem(key, ...members) {
      const s = sets.get(key);
      let n = 0;
      for (const m of members) if (s?.delete(m)) n++;
      return n;
    },
    async smembers(key) {
      return [...(sets.get(key) ?? [])].sort();
    },
    multi() {
      const ops: Array<() => Promise<unknown>> = [];
      const m: MemMulti = {
        set: (key, value, ...rest) => (ops.push(() => r.set(key, value, ...rest)), m),
        del: (...keys) => (ops.push(() => r.del(...keys)), m),
        sadd: (key, ...members) => (ops.push(() => r.sadd(key, ...members)), m),
        srem: (key, ...members) => (ops.push(() => r.srem(key, ...members)), m),
        async exec() {
          const out: Array<[null, unknown]> = [];
          for (const op of ops) out.push([null, await op()]);
          return out;
        },
      };
      return m;
    },
  };
  return r;
}
