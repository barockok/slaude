/**
 * Slice F safety proof (rc.22 behaves like rc.21): with SLAUDE_PERSON_SLICES
 * unset, `off`, `shadow` (the legacy answer is still the one returned), `union`
 * (not honoured yet, so it reads as off) or garbage, every scope decision equals
 * rc.21's, and every credential decision is unchanged by the pointer. The oracle
 * for scope is the frozen rc.21 source in tests/slices/rc21 (byte-identical to
 * the released files); the oracle for credentials is the same reads with every
 * pointer NULL. Seeded, so a failure reproduces.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as Accounts from "../../src/db/accounts";
import * as Creds from "../../src/db/mcp-credentials";
import * as Domain from "../../src/db/domain";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import { db } from "../../src/db/schema";
import type { GateInput } from "../../src/knowledge/gated-dispatch";
import { resolveBrainScope, type ScopeInput } from "../../src/knowledge/scope";
import { memoryScopeFor } from "../../src/memory/scope";
import { decidePersonSlices, settlePersonSliceShadows } from "../../src/slices/decide";
import { resolveBrainScope as resolveRc21 } from "./rc21/knowledge-scope";
import { memoryScopeFor as memoryRc21 } from "./rc21/memory-scope";
import { TEAM, newUser, resetWorld, slack } from "../helpers/person-world";

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
      const kb = r() < 0.5 ? ["kb-a", "kb-b"] : [];
      const input: ScopeInput = { ...g, kbSources: kb };
      if (userId) decidePersonSlices({ site: "brain.gate_speaker", teamId: g.teamId, slackUserId: userId });
      expect(await resolveBrainScope(input)).toEqual(await resolveRc21(input));
      const opts = { channel: pick(r, ["D0EXAMPLE", "C0EXAMPLE", undefined]), runAsUser: pick(r, [null, null, ...people.filter((p) => p !== null)]) };
      if (opts.runAsUser) decidePersonSlices({ site: "memory.claims_run_as", teamId: g.teamId, slackUserId: opts.runAsUser });
      expect(await memoryScopeFor(g, opts)).toEqual(await memoryRc21(g, opts));
    }
    await settlePersonSliceShadows();
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

  test("the scope files are the rc.21 files (nothing in rc.22 edits a scope site; task 8 retires this test)", () => {
    const unfreeze = (t: string) =>
      t
        .split("\n")
        .slice(2)
        .join("\n")
        .replaceAll("../../../src/access/wired", "../access/wired")
        .replaceAll("../../../src/soul/data", "../soul/data")
        .replaceAll("../../../src/knowledge/gated-dispatch", "../knowledge/gated-dispatch")
        .replaceAll("./knowledge-scope", "../knowledge/scope");
    expect(readFileSync("src/knowledge/scope.ts", "utf8")).toBe(unfreeze(readFileSync("tests/slices/rc21/knowledge-scope.ts", "utf8")));
    expect(readFileSync("src/memory/scope.ts", "utf8")).toBe(unfreeze(readFileSync("tests/slices/rc21/memory-scope.ts", "utf8")));
  });
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
