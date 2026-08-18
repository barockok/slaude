/** Minimal in-memory stand-in for the subset of the `redis` v6 client API
 *  RedisLeaseStore/RedisForwarder actually call. Backed by shared store/expiry/
 *  handlers maps passed at construction so `.duplicate()` and repeated
 *  `createClient()` calls simulate independent connections to one server.
 *
 *  Implements real TTL expiry (via wall-clock timestamps, checked lazily on
 *  access) — a keys-live-forever fake would make any "TTL expires without a
 *  heartbeat" test vacuously true regardless of whether the real expiration
 *  option was even passed correctly. Confirmed against real Redis in
 *  tests/cluster/redis-integration.test.ts. */
export class FakeRedisClient {
  constructor(
    public store: Map<string, string> = new Map(),
    public handlers: Map<string, (message: string) => void> = new Map(),
    private expiresAt: Map<string, number> = new Map(),
  ) {}

  async connect(): Promise<void> {}
  on(): this {
    return this;
  }

  #prune(key: string): void {
    const exp = this.expiresAt.get(key);
    if (exp !== undefined && Date.now() >= exp) {
      this.store.delete(key);
      this.expiresAt.delete(key);
    }
  }

  async get(key: string): Promise<string | null> {
    this.#prune(key);
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  async set(
    key: string,
    value: string,
    opts?: { condition?: "NX" | "XX"; expiration?: { type: "EX"; value: number } },
  ): Promise<"OK" | null> {
    this.#prune(key);
    const exists = this.store.has(key);
    if (opts?.condition === "NX" && exists) return null;
    if (opts?.condition === "XX" && !exists) return null;
    this.store.set(key, value);
    if (opts?.expiration?.type === "EX") {
      this.expiresAt.set(key, Date.now() + opts.expiration.value * 1000);
    } else {
      this.expiresAt.delete(key);
    }
    return "OK";
  }

  // RELEASE_SCRIPT passes 1 argument (self instance id); STEAL_SCRIPT passes 3
  // (fromInstance, toInstance, ttl). Distinguishing by arity avoids depending
  // on the lease module's private Lua source strings.
  async eval(_script: string, opts: { keys: string[]; arguments: string[] }): Promise<number | "OK" | null> {
    const key = opts.keys[0]!;
    this.#prune(key);
    const current = this.store.get(key) ?? null;
    if (opts.arguments.length === 1) {
      const [owner] = opts.arguments;
      if (current === owner) {
        this.store.delete(key);
        this.expiresAt.delete(key);
        return 1;
      }
      return 0;
    }
    const [fromInstance, toInstance, ttlSeconds] = opts.arguments;
    if (current === fromInstance) {
      this.store.set(key, toInstance!);
      this.expiresAt.set(key, Date.now() + Number(ttlSeconds) * 1000);
      return "OK";
    }
    return null;
  }

  duplicate(): FakeRedisClient {
    return new FakeRedisClient(this.store, this.handlers, this.expiresAt);
  }

  async publish(channel: string, message: string): Promise<number> {
    const handler = this.handlers.get(channel);
    if (!handler) return 0;
    handler(message);
    return 1;
  }

  async subscribe(channel: string, listener: (message: string) => void): Promise<void> {
    this.handlers.set(channel, listener);
  }

  async unsubscribe(): Promise<void> {
    this.handlers.clear();
  }
}
