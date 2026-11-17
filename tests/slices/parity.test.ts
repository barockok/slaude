/**
 * Slice F safety proof: the SCOPE functions against rc.21. The oracle is the frozen
 * rc.21 source in tests/slices/rc21 (byte-identical to the released files).
 *  - The matrix hands the scope functions a gate input and compares with rc.21's. In every mode
 *    but `union` the gate input ALSO carries a stray union `person`, which the sites must ignore
 *    (they re-check the flag): unset, off, shadow and garbage are byte-identical to rc.21. In
 *    `union` the gate carries none, so it is identical too.
 *  - The gate construction itself (`brainGateFor`, `memoryScopeForClaims`) is proven end to end in
 *    tests/gateway/core/person-slices-parity.test.ts; this file does not claim it.
 *  - Credential reads are unchanged by the pointer: the oracle is the same reads with every
 *    pointer NULL. Seeded, so a failure reproduces.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as Accounts from "../../src/db/accounts";
import * as Creds from "../../src/db/mcp-credentials";
import * as Domain from "../../src/db/domain";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import { db } from "../../src/db/schema";
import type { GateInput } from "../../src/knowledge/gated-dispatch";
import { resolveBrainScope, userSourceId, type ScopeInput } from "../../src/knowledge/scope";
import { memoryScopeFor } from "../../src/memory/scope";
import { decidePersonSlices } from "../../src/slices/decide";
import { resolveBrainScope as resolveRc21 } from "./rc21/knowledge-scope";
import { memoryScopeFor as memoryRc21 } from "./rc21/memory-scope";
import { TEAM, newUser, resetWorld, slack, cleanWorld } from "../helpers/person-world";

const MODES: Array<string | undefined> = [undefined, "off", "shadow", "union", "garbage"];

function rng(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

beforeEach(() => {
  delete process.env.SLAUDE_PERSON_SLICES;
  spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.SLAUDE_PERSON_SLICES;
  spyOn(console, "warn").mockRestore();
});

const setMode = (v: string | undefined) => (v === undefined ? delete process.env.SLAUDE_PERSON_SLICES : (process.env.SLAUDE_PERSON_SLICES = v));

describe("scope parity with rc.21", () => {
  test("the matrix: 3000 random scope inputs, every mode, equal to the frozen rc.21 functions", async () => {
    // A world where some of the speakers hold two verified ids (so a union WOULD widen if it were wired).
    await resetWorld();
    const a = await newUser();
    await slack(a, "U0AEXAMPLE");
    await slack(a, "U1AEXAMPLE");
    const b = await newUser();
    await slack(b, "U0BEXAMPLE");
    await slack(b, "U1BEXAMPLE", "observed");
    const people = [null, "U0AEXAMPLE", "U1AEXAMPLE", "U0BEXAMPLE", "U1BEXAMPLE", "U0CEXAMPLE"] as const;
    const r = rng(20261115);
    for (let i = 0; i < 3000; i++) {
      const mode = MODES[i % MODES.length];
      setMode(mode);
      const userId = pick(r, people);
      const g: GateInput = {
        userId,
        teamId: pick(r, [TEAM, null]),
        interactive: true,
        lockedUser: pick(r, [null, null, ...people.filter((p) => p !== null)]),
        lockedTeamId: pick(r, [null, TEAM]),
        channelTrust: pick(r, ["trusted", "public", "unknown"] as const),
        isManager: r() < 0.3,
        agentId: pick(r, ["agent-one", "agent-two"]),
      };
      // A stray union person (for the speaker, plus a runAs person): ignored unless the flag is `union`.
      const stray = (id: string | null) => (id && mode !== "union" ? { own: userSourceId(id), reads: [userSourceId(id), "user-u9strayexample"], via: "union" as const, dropped: { conflict: 0, tombstoned: 0 } } : undefined);
      const sp = stray(userId);
      if (sp) g.person = sp;
      const kb = r() < 0.5 ? ["kb-a", "kb-b"] : [];
      const input: ScopeInput = { ...g, kbSources: kb };
      expect(await resolveBrainScope(input)).toEqual(await resolveRc21(input));
      const opts = { channel: pick(r, ["D0EXAMPLE", "C0EXAMPLE", undefined]), runAsUser: pick(r, [null, null, ...people.filter((p) => p !== null)]) };
      const rp = stray(opts.runAsUser);
      expect(await memoryScopeFor(g, { ...opts, ...(rp ? { runAsPerson: rp } : {}) })).toEqual(await memoryRc21(g, opts));
    }
  });

  test("a verified person with two ids still reads only own plus the lock rules, and a lock held by someone else is public-only (Rule S)", async () => {
    await resetWorld();
    const a = await newUser();
    await slack(a, "U0AEXAMPLE");
    await slack(a, "U1AEXAMPLE");
    for (const mode of MODES) {
      setMode(mode);
      const base: ScopeInput = { userId: "U0AEXAMPLE", teamId: TEAM, lockedUser: "U0ZEXAMPLE", channelTrust: "trusted", isManager: false, kbSources: [], agentId: "agent-one" };
      const locked = await resolveBrainScope(base);
      expect(locked.sourceId).toBe("public");
      // Public plus the speaker's own profile (rc.21's rule) and nothing else: no user- slice of either id.
      expect(locked.allowedSources[0]).toBe("public");
      expect(locked.allowedSources.filter((x) => x.startsWith("user-"))).toEqual([]);
      expect(locked.allowedSources).toHaveLength(2);
      const own = await resolveBrainScope({ ...base, lockedUser: "U0AEXAMPLE" });
      expect(own.allowedSources.filter((s) => s.startsWith("user-"))).toEqual(["user-u0aexample"]);
    }
  });

  test("union mode with no person attached is still byte-identical to rc.21 (the attach is the only difference)", async () => {
    process.env.SLAUDE_PERSON_SLICES = "union";
    const input: ScopeInput = { userId: "U0AEXAMPLE", teamId: TEAM, lockedUser: "U0AEXAMPLE", channelTrust: "public", isManager: false, kbSources: [], agentId: "agent-one" };
    expect(await resolveBrainScope(input)).toEqual(await resolveRc21(input));
  });
});

describe("union mode against rc.21", () => {
  test("5000 random worlds: one verified id (or none) is byte-identical to rc.21; with a union only the verified extras are added, to reads only", async () => {
    process.env.SLAUDE_PERSON_SLICES = "union";
    await resetWorld();
    // A: two verified ids and an observed third. B: one verified id. C: observed only. D: three verified ids, one name claimed by E.
    const a = await newUser();
    await slack(a, "U0AEXAMPLE");
    await slack(a, "U1AEXAMPLE");
    await slack(a, "U2AEXAMPLE", "observed");
    const b = await newUser();
    await slack(b, "U0BEXAMPLE");
    const c = await newUser();
    await slack(c, "U0CEXAMPLE", "observed");
    const d = await newUser();
    for (const v of ["U0DEXAMPLE", "U1DEXAMPLE", "U2DEXAMPLE"]) await slack(d, v);
    const e = await newUser();
    await slack(e, "U2DEXAMPLE", "observed", "T9EXAMPLE");
    const expected: Record<string, string[]> = {
      U0AEXAMPLE: ["user-u1aexample"],
      U1AEXAMPLE: ["user-u0aexample"],
      U0DEXAMPLE: ["user-u1dexample"],
      U1DEXAMPLE: ["user-u0dexample"],
      U2DEXAMPLE: ["user-u0dexample", "user-u1dexample"],
    };
    const people = [null, "U0AEXAMPLE", "U1AEXAMPLE", "U2AEXAMPLE", "U0BEXAMPLE", "U0CEXAMPLE", "U0DEXAMPLE", "U1DEXAMPLE", "U2DEXAMPLE", "U0ZEXAMPLE"] as const;
    const personOf = new Map<string, Awaited<ReturnType<typeof decidePersonSlices>>>();
    for (const p of people) if (p) personOf.set(p, await decidePersonSlices({ site: "brain.gate_speaker", teamId: TEAM, slackUserId: p }));
    const r = rng(5150);
    for (let i = 0; i < 5000; i++) {
      const userId = pick(r, people);
      const person = userId ? personOf.get(userId) : undefined;
      const g: GateInput = {
        userId,
        teamId: TEAM,
        interactive: true,
        lockedUser: pick(r, [null, null, ...people.filter((p) => p !== null)]),
        lockedTeamId: null,
        channelTrust: pick(r, ["trusted", "public", "unknown"] as const),
        isManager: r() < 0.3,
        agentId: pick(r, ["agent-one", "agent-two"]),
        ...(person ? { person } : {}),
      };
      const kb = r() < 0.5 ? ["kb-a"] : [];
      const input: ScopeInput = { ...g, kbSources: kb };
      const legacyKb = await resolveRc21(input);
      const gotKb = await resolveBrainScope(input);
      const opts = { channel: pick(r, ["D0EXAMPLE", "C0EXAMPLE", undefined]), runAsUser: pick(r, [null, null, ...people.filter((p) => p !== null)]) };
      const runAsPerson = opts.runAsUser ? personOf.get(opts.runAsUser) : undefined;
      const legacyMem = await memoryRc21(g, opts);
      const gotMem = await memoryScopeFor(g, { ...opts, ...(runAsPerson ? { runAsPerson } : {}) });
      const extra = (u: string | null) => (u ? (expected[u] ?? []) : []);
      // KB scope: identical except reads gain the speaker's verified extras, and only in the speaker's own lock.
      expect({ ...gotKb, allowedSources: undefined }).toEqual({ ...legacyKb, allowedSources: undefined });
      const added = gotKb.allowedSources.filter((x) => !legacyKb.allowedSources.includes(x));
      expect(gotKb.allowedSources.filter((x) => legacyKb.allowedSources.includes(x))).toEqual(legacyKb.allowedSources);
      expect(added.length === 0 || added.every((n) => extra(userId).includes(n))).toBe(true);
      if (added.length > 0) expect(gotKb.sourceId).toBe(userSourceId(userId!));
      // Memory scope: the write side is always identical; the read side differs only by verified extras.
      expect(gotMem.write).toEqual(legacyMem.write);
      expect(gotMem.read === null).toBe(legacyMem.read === null);
      if (gotMem.read && legacyMem.read) {
        expect({ ...gotMem.read, allowedSources: undefined }).toEqual({ ...legacyMem.read, allowedSources: undefined });
        const addedM = gotMem.read.allowedSources.filter((x) => !legacyMem.read!.allowedSources.includes(x));
        expect(gotMem.read.allowedSources.filter((x) => legacyMem.read!.allowedSources.includes(x))).toEqual(legacyMem.read.allowedSources);
        const who = opts.runAsUser ?? userId;
        expect(addedM.every((n) => extra(who).includes(n))).toBe(true);
      }
      // Per-agent, shared, public and kb sources never differ.
      const nonPerson = (xs: string[]) => xs.filter((x) => !x.startsWith("user-"));
      expect(nonPerson(gotKb.allowedSources)).toEqual(nonPerson(legacyKb.allowedSources));
    }
    // A person with a single verified id (B) or none verified (C, the unclaimed-name case D2) never gets extras.
    expect(personOf.get("U0BEXAMPLE")).toBeUndefined();
    expect(personOf.get("U0CEXAMPLE")).toBeUndefined();
    expect(personOf.get("U2AEXAMPLE")).toBeUndefined();
    expect(personOf.get("U0ZEXAMPLE")).toBeUndefined();
    expect(personOf.get("U0DEXAMPLE")!.reads).toEqual(["user-u0dexample", "user-u1dexample"]);
  }, 600_000);
});

describe("credential decisions are unchanged by the pointer", () => {
  const ISS = "https://idp.example.com";
  const entry = (t: string) => ({ serverName: "workbench", serverUrl: "https://mcp.example.com", accessToken: t, refreshToken: "r", expiresAt: Date.now() + 3600_000 });

  test("the matrix: random pointers and flags never change which credentials or accounts a read returns", async () => {
    process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
    __resetMasterKeyCache();
    const r = rng(777);
    for (let round = 0; round < 12; round++) {
      await resetWorld();
      await db.run("DELETE FROM mcp_credentials");
      const users = [await newUser(), await newUser(), await newUser()];
      const accounts: string[] = [];
      for (let i = 0; i < 3; i++) {
        const acct = await Accounts.upsertAccount({ issuer: ISS, subject: `sub-${round}-${i}`, email: `p${i}@example.com` });
        accounts.push(acct.id);
        if (r() < 0.8) await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: `U${round}${i}EXAMPLE`, accountId: acct.id, via: "test" });
        for (const key of ["k1", "k2"]) if (r() < 0.8) await Creds.putCredential({ kind: "account", accountId: acct.id }, key, entry(`tok-${round}-${i}-${key}`));
      }
      await Creds.putCredential({ kind: "agent", tenant: "t1", persona: "p1" }, "k1", entry("agent-tok"));
      const reads = async () => ({
        creds: await Promise.all(accounts.map((id) => Creds.credentialsFor({ kind: "account", accountId: id }))),
        exp: await Promise.all(accounts.map((id) => Creds.credentialExpiries({ kind: "account", accountId: id }))),
        stored: await Promise.all(accounts.map((id) => Creds.storedExpiry({ kind: "account", accountId: id }, "k1"))),
        agent: await Creds.credentialsFor({ kind: "agent", tenant: "t1", persona: "p1" }),
        links: await Promise.all(accounts.map(async (_, i) => (await Accounts.accountForSlackUser(TEAM, `U${round}${i}EXAMPLE`))?.id ?? null)),
        anyTeam: await Promise.all(accounts.map((_, i) => Accounts.accountIdsForSlackUserAnyTeam(`U${round}${i}EXAMPLE`))),
        ids: await Promise.all(accounts.map((id) => Accounts.slackIdentitiesForAccount(id))),
      });
      // Baseline: every pointer NULL (what rc.21's table looks like).
      await db.run("UPDATE mcp_credentials SET user_id = NULL");
      const baseline = await reads();
      for (const mode of MODES) {
        setMode(mode);
        for (const row of await db.query<{ id: string }>("SELECT id FROM mcp_credentials WHERE account_id IS NOT NULL")) {
          const v = pick(r, [null, ...users]);
          await db.run("UPDATE mcp_credentials SET user_id = ? WHERE id = ?", [v, row.id]);
        }
        expect(await reads()).toEqual(baseline);
      }
      // And a merge (which repoints pointers) changes no credential read either.
      setMode("shadow");
      const s = users[0]!;
      const l = await Domain.ensureUser({});
      await Domain.ensureBinding({ service: "slack", kind: "user", workspace: TEAM, value: `UL${round}EXAMPLE`, userId: l.id, state: "observed", source: "test" });
      const { mergeUsers } = await import("../../src/domain/merge");
      process.env.SLAUDE_MERGE_NOTICE = "off";
      await mergeUsers({ survivorId: s, loserId: l.id, kind: "console", actor: "UOPERATOR" });
      delete process.env.SLAUDE_MERGE_NOTICE;
      expect(await reads()).toEqual(baseline);
    }
  });
});

afterAll(async () => {
  await cleanWorld();
});
