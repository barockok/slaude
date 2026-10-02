import { describe, it, expect } from "bun:test";
import { HELD_BY_OTHER } from "../../src/queue/locks";
import { makeRemoteResolver } from "../../src/node/remote";
import { runLockedTurn, STALE_CONFIG } from "../../src/node/worker";

/** Unsigned token shape: only the payload segment matters to the node-side decode. */
const tok = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

/** One session's lock, in memory: a second taker gets HELD_BY_OTHER at once,
 *  as withSessionLock does. */
function memLock() {
  let held = false;
  return async <T>(fn: (lost: AbortSignal) => Promise<T>): Promise<T | typeof HELD_BY_OTHER> => {
    if (held) return HELD_BY_OTHER;
    held = true;
    try {
      return await fn(new AbortController().signal);
    } finally {
      held = false;
    }
  };
}

describe("runLockedTurn", () => {
  it("a job that loses the lock race does not change the token the holder's boot reads", async () => {
    const tokens = new Map<string, string>();
    const store = { bindToken: (t: string) => tokens.set("S", t), tokenFor: (id: string) => tokens.get(id) };
    const resolveRemote = makeRemoteResolver(store);
    const lock = memLock();
    const t1 = tok({ runAs: "user:U_A", team: "T1", remote: { addr: "tcA", dir: "/r" }, sessionConfigFp: "fp1" });
    const t0 = tok({ runAs: "user:U_A", team: "T1", sessionConfigFp: "fp0" }); // an older job: no remote

    let letBootResolve!: () => void;
    const bootMayResolve = new Promise<void>((r) => (letBootResolve = r));
    let bootRead: unknown = "unset";
    let inBoot!: () => void;
    const bootStarted = new Promise<void>((r) => (inBoot = r));

    const holder = runLockedTurn({
      lock,
      bindToken: store.bindToken,
      ensureConfigFp: async () => true,
      jobToken: t1,
      run: async () => {
        inBoot();
        await bootMayResolve; // the boot awaits its resolvers here
        bootRead = await resolveRemote("S");
        return "done" as const;
      },
    });
    await bootStarted;
    const loser = await runLockedTurn({
      lock,
      bindToken: store.bindToken,
      ensureConfigFp: async () => true,
      jobToken: t0,
      run: async () => "done" as const,
    });
    expect(loser).toBe(HELD_BY_OTHER);
    letBootResolve();
    expect(await holder).toBe("done");
    expect(tokens.get("S")).toBe(t1);
    expect(bootRead).toEqual({ teamId: "T1", userId: "U_A", addr: "tcA", dir: "/r" });
  });

  it("checks the job's own fingerprint after binding, and never runs the turn when it is not current", async () => {
    const order: string[] = [];
    const t = tok({ sessionConfigFp: "fp2" });
    let seen: string | undefined;
    const res = await runLockedTurn({
      lock: memLock(),
      bindToken: () => order.push("bind"),
      ensureConfigFp: async (fp) => { order.push("check"); seen = fp; return false; },
      jobToken: t,
      run: async () => { order.push("run"); return "done" as const; },
    });
    expect(res).toBe(STALE_CONFIG);
    expect(order).toEqual(["bind", "check"]);
    expect(seen).toBe("fp2");
  });
});
