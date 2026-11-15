import { describe, it, expect } from "bun:test";
import { decodeClaims, makeRemoteFactory, makeRemoteResolver } from "../../src/node/remote";
import { NodeApiError } from "../../src/node/client";
import { RemoteError } from "../../src/remote/types";
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

  it("an environment claim on a user turn carries the env ref", async () => {
    const envRef = { id: "E1", kind: "ssh", trust: "user-machine" as const, name: "box", hash: "h1" };
    const r = makeRemoteResolver(storeOf({ S1: tok({ team: "T1", runAs: "user:UTESTA", remote: { addr: "", dir: "/r", env: envRef } }) }));
    expect(await r("S1")).toEqual({ teamId: "T1", userId: "UTESTA", addr: "", dir: "/r", env: envRef });
  });

  it("a user-machine environment on an agent turn → null", async () => {
    const envRef = { id: "E1", kind: "ssh", trust: "user-machine" as const, name: "box", hash: "h1" };
    const r = makeRemoteResolver(storeOf({ S1: tok({ team: "T1", runAs: "agent", remote: { addr: "", dir: "/r", env: envRef } }) }));
    expect(await r("S1")).toBeNull();
  });

  it("a provisioned sandbox applies to an agent turn too", async () => {
    const envRef = { id: "E2", kind: "sandbox", trust: "provisioned" as const, name: "sb", hash: "h2" };
    const r = makeRemoteResolver(storeOf({ S1: tok({ team: "T1", runAs: "agent", remote: { addr: "", dir: "/w", env: envRef } }) }));
    expect(await r("S1")).toEqual({ teamId: "T1", userId: "", addr: "", dir: "/w", env: envRef });
  });

  it("decodeClaims is still exported from the worker", () => {
    expect(workerDecodeClaims).toBe(decodeClaims);
  });
});

describe("makeRemoteFactory", () => {
  const target = { teamId: "T1", userId: "UTESTA", addr: "tcA", dir: "/r" };

  function setup(over: { tenant?: string; token?: string } = {}) {
    const keyCalls: Array<[string, string]> = [];
    const envCalls: Array<[string, string]> = [];
    const built: any[] = [];
    const handle = { exec: async () => ({ stdout: "", stderr: "", code: 0, truncated: false, timedOut: false }), release: async () => {}, dispose: async () => {} };
    const factory = makeRemoteFactory({
      client: {
        getRemoteKey: async (tenant: string, token: string) => { keyCalls.push([tenant, token]); return "PRIVATE-KEY-MATERIAL"; },
        getRemoteEnv: async (tenant: string, token: string) => {
          envCalls.push([tenant, token]);
          return { transport: { kind: "ssh" as const, host: "203.0.113.5", port: 22, username: "dev", hostKey: "SHA256:x" }, privateKey: "ENV-KEY" };
        },
      },
      store: storeOf(over.token === undefined ? {} : { S1: over.token }),
      tenants: new Map(over.tenant === undefined ? [] : [["S1", over.tenant]]),
      newHelper: (opts) => { built.push(opts); return handle; },
    });
    return { factory, keyCalls, envCalls, built, handle };
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

  it("an environment target fetches its connect info from the gateway, not the bare key", async () => {
    const s = setup({ tenant: "t1", token: "tok-1" });
    const envTarget = { ...target, addr: "", env: { id: "E1", kind: "ssh", trust: "user-machine" as const, name: "box", hash: "h" } };
    expect(await s.factory("S1", envTarget)).toBe(s.handle);
    expect(s.keyCalls).toEqual([]);
    expect(s.envCalls).toEqual([["t1", "tok-1"]]);
    expect(s.built[0].transport).toEqual({ kind: "ssh", host: "203.0.113.5", port: 22, username: "dev", hostKey: "SHA256:x" });
    expect(s.built[0].privateKey).toBe("ENV-KEY");
  });
});

describe("a shared machine is re-checked while its handle lives", () => {
  const shared = { teamId: "T1", userId: "", addr: "", dir: "/srv/work", env: { id: "D1", kind: "ssh", trust: "provisioned" as const, name: "team-sandbox", hash: "h", shared: true as const } };
  function setup(refetch: () => Promise<unknown>) {
    let clock = 0;
    let execs = 0;
    let disposed = 0;
    let fetched = 0;
    let token = "tok-1";
    const inner = { exec: async () => { execs++; return { stdout: "", stderr: "", code: 0, truncated: false, timedOut: false }; }, release: async () => {}, dispose: async () => { disposed++; } };
    const factory = makeRemoteFactory({
      client: {
        getRemoteKey: async () => "unused",
        getRemoteEnv: async () => {
          fetched++;
          if (fetched > 1) await refetch();
          return { transport: { kind: "ssh" as const, host: "203.0.113.5", port: 22, username: "dev", hostKey: "SHA256:x" }, privateKey: "KEY" };
        },
      },
      store: { tokenFor: () => token },
      tenants: new Map([["S1", "t1"]]),
      newHelper: () => inner,
      revalidateMs: 1000,
      now: () => clock,
    });
    return { factory, tick: (ms: number) => { clock += ms; }, setToken: (t: string) => { token = t; }, counts: () => ({ execs, disposed, fetched }) };
  }
  const exec = (h: { exec: (c: string, o: { timeoutMs: number }) => Promise<unknown> }) => h.exec("true", { timeoutMs: 1000 });

  it("asks again after the interval with the session's current token; an allowed agent keeps running", async () => {
    const s = setup(async () => {});
    const h = await s.factory("S1", shared);
    await exec(h);
    s.tick(500);
    await exec(h);
    expect(s.counts().fetched).toBe(1);
    s.tick(600);
    s.setToken("tok-2");
    await exec(h);
    expect(s.counts()).toEqual({ execs: 3, disposed: 0, fetched: 2 });
  });

  it("once the gateway refuses (403 or 409) the next exec is refused and the session's remote jobs are cleaned up", async () => {
    for (const status of [403, 409]) {
      const s = setup(async () => { throw new NodeApiError(status, '{"error":"this environment may not be used by this turn"}'); });
      const h = await s.factory("S1", shared);
      await exec(h);
      s.tick(1500);
      await expect(exec(h)).rejects.toBeInstanceOf(RemoteError);
      expect(s.counts().execs).toBe(1);
      expect(s.counts().disposed).toBe(1);
      await expect(exec(h)).rejects.toBeInstanceOf(RemoteError);
      expect(s.counts().execs).toBe(1);
    }
  });

  it("a network error refuses that exec without cleaning anything up, and an unshared environment is never re-checked", async () => {
    const s = setup(async () => { throw new Error("socket hang up"); });
    const h = await s.factory("S1", shared);
    s.tick(1500);
    await expect(exec(h)).rejects.toBeInstanceOf(RemoteError);
    expect(s.counts().disposed).toBe(0);
    const p = setup(async () => { throw new NodeApiError(403, "no"); });
    const plain = await p.factory("S1", { ...shared, env: { ...shared.env, shared: undefined } as never });
    p.tick(10_000);
    await exec(plain);
    expect(p.counts().fetched).toBe(1);
  });
});
