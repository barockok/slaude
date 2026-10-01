import { describe, it, expect } from "bun:test";
import { decodeClaims, makeRemoteFactory, makeRemoteResolver } from "../../src/node/remote";
import { decodeClaims as workerDecodeClaims } from "../../src/node/worker";

/** Unsigned token shape: only the payload segment matters to the node-side decode. */
const tok = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const storeOf = (tokens: Record<string, string>) => ({ tokenFor: (id: string) => tokens[id] });
const REMOTE = { addr: "tcA", dir: "/home/a/repo" };

describe("makeRemoteResolver", () => {
  it("user runAs + remote claim → target", async () => {
    const r = makeRemoteResolver(storeOf({ S1: tok({ team: "T1", runAs: "user:UTESTA", remote: REMOTE }) }));
    expect(await r("S1")).toEqual({ teamId: "T1", userId: "UTESTA", addr: "tcA", dir: "/home/a/repo" });
  });

  it("a remote claim on an agent turn → null", async () => {
    const r = makeRemoteResolver(storeOf({ S1: tok({ team: "T1", runAs: "agent", remote: REMOTE }) }));
    expect(await r("S1")).toBeNull();
  });

  it("malformed runAs → null", async () => {
    for (const runAs of ["user:", "user:U A", "user:../x", "UTESTA", 42, undefined]) {
      const r = makeRemoteResolver(storeOf({ S1: tok({ team: "T1", runAs, remote: REMOTE }) }));
      expect(await r("S1")).toBeNull();
    }
  });

  it("no remote claim, missing token, or an undecodable token → null", async () => {
    expect(await makeRemoteResolver(storeOf({ S1: tok({ runAs: "user:UTESTA" }) }))("S1")).toBeNull();
    expect(await makeRemoteResolver(storeOf({}))("S1")).toBeNull();
    expect(await makeRemoteResolver(storeOf({ S1: "not-a-jwt" }))("S1")).toBeNull();
  });

  it("decodeClaims is still exported from the worker", () => {
    expect(workerDecodeClaims).toBe(decodeClaims);
  });
});

describe("makeRemoteFactory", () => {
  const target = { teamId: "T1", userId: "UTESTA", addr: "tcA", dir: "/r" };

  function setup(over: { tenant?: string; token?: string } = {}) {
    const keyCalls: Array<[string, string]> = [];
    const built: any[] = [];
    const handle = { exec: async () => ({ stdout: "", stderr: "", code: 0, truncated: false, timedOut: false }), release: async () => {}, dispose: async () => {} };
    const factory = makeRemoteFactory({
      client: { getRemoteKey: async (tenant: string, token: string) => { keyCalls.push([tenant, token]); return "PRIVATE-KEY-MATERIAL"; } },
      store: storeOf(over.token === undefined ? {} : { S1: over.token }),
      tenants: new Map(over.tenant === undefined ? [] : [["S1", over.tenant]]),
      newHelper: (opts) => { built.push(opts); return handle; },
    });
    return { factory, keyCalls, built, handle };
  }

  it("refuses without a tenant or a token, before fetching any key", async () => {
    for (const s of [setup({ token: "tok" }), setup({ tenant: "t1" })]) {
      await expect(s.factory("S1", target)).rejects.toThrow("no job token");
      expect(s.keyCalls).toEqual([]);
      expect(s.built).toEqual([]);
    }
  });

  it("fetches the key with the session's token and builds a tailcat helper whose dispose cleans up the session", async () => {
    const s = setup({ tenant: "t1", token: "tok-1" });
    expect(await s.factory("S1", target)).toBe(s.handle);
    expect(s.keyCalls).toEqual([["t1", "tok-1"]]);
    expect(s.built).toHaveLength(1);
    expect(s.built[0].transport).toEqual({ kind: "tailcat", addr: "tcA" });
    expect(s.built[0].privateKey).toBe("PRIVATE-KEY-MATERIAL");
    const ran: Array<[string, any]> = [];
    await s.built[0].onDispose(async (cmd: string, opts: any) => { ran.push([cmd, opts]); return { stdout: "", stderr: "", code: 0, truncated: false, timedOut: false }; });
    expect(ran).toHaveLength(1);
    expect(ran[0]![0]).toContain("S1");
    expect(ran[0]![1]).toEqual({ timeoutMs: 30_000 });
  });
});
