// liveNodeDetails over a stub Redis client: no SLAUDE_REDIS_TEST_URL needed.
// One SCAN listing, then one MGET for heartbeats and one for labels.
import { expect, test } from "bun:test";
import { makeKeys } from "../../src/queue/keys";
import { makeRegistry } from "../../src/queue/registry";

test("liveNodeDetails: live nodes with sorted labels and last heartbeat, sorted by node", async () => {
  const keys = makeKeys("t-details");
  const store: Record<string, string> = {
    [keys.node("n-b")]: "2000",
    [keys.nodeLabels("n-b")]: "finance,engineering",
    [keys.node("n-a")]: "1000",
    // n-a has no labels key: a pre-label node counts as `default`.
    [keys.node("n-c")]: "not-a-number",
    [keys.nodeLabels("n-c")]: "gpu",
  };
  const calls: string[] = [];
  const redis = {
    async scan(cursor: string, _m: string, pattern: string) {
      calls.push(`scan ${cursor}`);
      const prefix = pattern.slice(0, -1);
      // Two pages, to exercise the cursor loop.
      const all = Object.keys(store).filter((k) => k.startsWith(prefix));
      return cursor === "0" ? ["7", all.slice(0, 1)] : ["0", all.slice(1)];
    },
    async mget(...ks: string[]) {
      calls.push("mget");
      return ks.map((k) => store[k] ?? null);
    },
  };
  const reg = makeRegistry({ redis: redis as any, keys });
  expect(await reg.liveNodeDetails()).toEqual([
    { node: "n-a", labels: ["default"], lastBeat: 1000 },
    { node: "n-b", labels: ["engineering", "finance"], lastBeat: 2000 },
    { node: "n-c", labels: ["gpu"], lastBeat: null },
  ]);
  expect(calls).toEqual(["scan 0", "scan 7", "mget", "mget"]);
});

test("liveNodeDetails: no live node, no MGET", async () => {
  const keys = makeKeys("t-details-empty");
  let mgets = 0;
  const redis = { scan: async () => ["0", []], mget: async () => (mgets++, []) };
  expect(await makeRegistry({ redis: redis as any, keys }).liveNodeDetails()).toEqual([]);
  expect(mgets).toBe(0);
});
