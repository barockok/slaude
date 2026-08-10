/** Minimal in-memory stand-in for the subset of the `redis` v6 client API
 *  RedisLeaseStore/RedisForwarder actually call. Backed by a shared store/
 *  handlers map passed at construction so `.duplicate()` and repeated
 *  `createClient()` calls simulate independent connections to one server. */
export class FakeRedisClient {
  constructor(
    public store: Map<string, string> = new Map(),
    public handlers: Map<string, (message: string) => void> = new Map(),
  ) {}

  async connect(): Promise<void> {}
  on(): this {
    return this;
  }

  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  async set(key: string, value: string, opts?: { condition?: "NX" | "XX"; expiration?: unknown }): Promise<"OK" | null> {
    const exists = this.store.has(key);
    if (opts?.condition === "NX" && exists) return null;
    if (opts?.condition === "XX" && !exists) return null;
    this.store.set(key, value);
    return "OK";
  }

  // RELEASE_SCRIPT passes 1 argument (self instance id); STEAL_SCRIPT passes 3
  // (fromInstance, toInstance, ttl). Distinguishing by arity avoids depending
  // on the lease module's private Lua source strings.
  async eval(_script: string, opts: { keys: string[]; arguments: string[] }): Promise<number | "OK" | null> {
    const key = opts.keys[0]!;
    const current = this.store.get(key) ?? null;
    if (opts.arguments.length === 1) {
      const [owner] = opts.arguments;
      if (current === owner) {
        this.store.delete(key);
        return 1;
      }
      return 0;
    }
    const [fromInstance, toInstance] = opts.arguments;
    if (current === fromInstance) {
      this.store.set(key, toInstance!);
      return "OK";
    }
    return null;
  }

  duplicate(): FakeRedisClient {
    return new FakeRedisClient(this.store, this.handlers);
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
