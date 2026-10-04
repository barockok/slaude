/**
 * Signed node credentials (node labels and routing spec §4.1, §6 "Credential").
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { encodeJwt } from "../../../src/gateway/auth/jwt";
import { createHmac } from "node:crypto";
import {
  __resetNodeCredentialState,
  MAX_GAUGED_CREDENTIALS,
  MAX_NODE_TTL_SEC,
  MAX_STALE_REVOCATION_MS,
  nodeKeyViolations,
  REVOCATION_CACHE_MS,
  mintNodeCredential,
  NodeCredentialVerifier,
  revocationSourceFor,
  revokeNodeCredential,
  verifyNodeCredentialSync,
} from "../../../src/gateway/auth/node-credential";
import { mintJobToken, verifyJobToken } from "../../../src/gateway/api/auth";
import { metrics } from "../../../src/metrics";
import { openDb, type DbClient } from "../../../src/db/client";
import { runMigrations } from "../../../src/db/migrate";

const KEY = "node-key-for-tests";
const OLD = "previous-node-key";
const NOW = 1_800_000_000_000;

const mint = (over: Partial<{ id: string; labels: string[]; ttlSec: number }> = {}, key = KEY, now = NOW) =>
  mintNodeCredential({ id: "engineering-a", labels: ["engineering", "eu"], ...over }, { key, now });

/** Sign arbitrary claims with the key, bypassing mint's validation. */
const raw = (claims: object, key = KEY) => encodeJwt(claims, key);
const good = { v: 1, typ: "node", id: "engineering-a", labels: ["engineering"], iat: NOW / 1000, exp: NOW / 1000 + 3600 };

beforeEach(() => __resetNodeCredentialState());

describe("mint / verify", () => {
  test("round trip", () => {
    const r = verifyNodeCredentialSync(mint(), { keys: [KEY], now: NOW + 1000 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.claims.id).toBe("engineering-a");
      expect(r.claims.labels).toEqual(["engineering", "eu"]);
      expect(r.claims.v).toBe(1);
      expect(r.claims.exp - r.claims.iat).toBe(90 * 86400);
    }
  });

  test("wrong key", () => {
    expect(verifyNodeCredentialSync(mint(), { keys: ["other"], now: NOW })).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("expired", () => {
    const t = mint({ ttlSec: 60 });
    expect(verifyNodeCredentialSync(t, { keys: [KEY], now: NOW + 61_000 })).toEqual({ ok: false, reason: "expired" });
  });

  test("exp is mandatory", () => {
    const { exp: _e, ...noExp } = good;
    expect(verifyNodeCredentialSync(raw(noExp), { keys: [KEY], now: NOW })).toEqual({ ok: false, reason: "expired" });
  });

  test("labels empty, too many, malformed, duplicate: refused at mint and at verify", () => {
    const bad = [
      [],
      ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
      ["Engineering"],
      ["-lead"],
      ["a".repeat(33)],
      ["has space"],
      ["engineering", "engineering"],
    ];
    for (const labels of bad) {
      expect(() => mint({ labels })).toThrow();
      expect(verifyNodeCredentialSync(raw({ ...good, labels }), { keys: [KEY], now: NOW })).toEqual({ ok: false, reason: "bad_claims" });
    }
    // Eight is fine; "default" is an ordinary label.
    expect(() => mint({ labels: ["a", "b", "c", "d", "e", "f", "g", "default"] })).not.toThrow();
  });

  test("unknown v, missing typ, bad id", () => {
    for (const c of [{ ...good, v: 2 }, { ...good, typ: undefined }, { ...good, id: "legacy" }, { ...good, id: "" }]) {
      expect(verifyNodeCredentialSync(raw(c), { keys: [KEY], now: NOW })).toEqual({ ok: false, reason: "bad_claims" });
    }
    expect(() => mint({ id: "legacy" })).toThrow(/reserved/);
  });

  test("both keys during rotation", () => {
    const oldTok = mint({}, OLD);
    const newTok = mint({}, KEY);
    expect(verifyNodeCredentialSync(oldTok, { keys: [KEY, OLD], now: NOW }).ok).toBe(true);
    expect(verifyNodeCredentialSync(newTok, { keys: [KEY, OLD], now: NOW }).ok).toBe(true);
    // Previous key dropped: the old credential stops.
    expect(verifyNodeCredentialSync(oldTok, { keys: [KEY], now: NOW }).ok).toBe(false);
  });

  test("no key configured", () => {
    expect(verifyNodeCredentialSync(mint(), { keys: [], now: NOW })).toEqual({ ok: false, reason: "unconfigured" });
    expect(() => mintNodeCredential({ id: "a", labels: ["a"] }, { key: "" })).toThrow(/SLAUDE_NODE_KEY/);
  });

  test("a job token is not a node credential and the reverse, even under one key", () => {
    const job = mintJobToken(
      { tenant: "default", persona: "default", session: "S", team: "T", channel: "C", thread: "1", initiator: "U", scope: "turn" },
      { secret: KEY, now: NOW },
    );
    expect(verifyNodeCredentialSync(job, { keys: [KEY], now: NOW })).toEqual({ ok: false, reason: "bad_claims" });
    expect(verifyJobToken(mint(), { secret: KEY, now: NOW })).toEqual({ ok: false, reason: "bad_claims" });
  });
});

describe("claim hardening", () => {
  test("a HYBRID token carrying both claim shapes under one key is refused by both verifiers", () => {
    const hybrid = raw({
      ...good,
      tenant: "default", persona: "default", session: "S", team: "T", channel: "C", thread: "1", initiator: "U", scope: "turn",
    });
    expect(verifyJobToken(hybrid, { secret: KEY, now: NOW })).toEqual({ ok: false, reason: "bad_claims" });
    expect(verifyNodeCredentialSync(hybrid, { keys: [KEY], now: NOW })).toEqual({ ok: false, reason: "bad_claims" });
  });

  test("iat more than 300 s in the future is refused", () => {
    expect(verifyNodeCredentialSync(raw({ ...good, iat: NOW / 1000 + 301, exp: NOW / 1000 + 7200 }), { keys: [KEY], now: NOW }))
      .toEqual({ ok: false, reason: "bad_claims" });
    expect(verifyNodeCredentialSync(raw({ ...good, iat: NOW / 1000 + 299 }), { keys: [KEY], now: NOW }).ok).toBe(true);
  });

  test(`lifetime is capped at ${MAX_NODE_TTL_SEC / 86400} days`, () => {
    const over = raw({ ...good, exp: good.iat + MAX_NODE_TTL_SEC + 1 });
    expect(verifyNodeCredentialSync(over, { keys: [KEY], now: NOW })).toEqual({ ok: false, reason: "bad_claims" });
    expect(verifyNodeCredentialSync(raw({ ...good, exp: good.iat + MAX_NODE_TTL_SEC }), { keys: [KEY], now: NOW }).ok).toBe(true);
    expect(() => mint({ ttlSec: MAX_NODE_TTL_SEC + 1 })).toThrow(/lifetime/);
  });

  test("a non-object payload is refused, never thrown", () => {
    const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    for (const body of ["null", "5", '"x"', "[]", "true"]) {
      const b = Buffer.from(body).toString("base64url");
      const sig = createHmac("sha256", KEY).update(`${head}.${b}`).digest("base64url");
      const tok = `${head}.${b}.${sig}`;
      const r = verifyNodeCredentialSync(tok, { keys: [KEY], now: NOW });
      expect(r.ok).toBe(false);
      expect(verifyJobToken(tok, { secret: KEY, now: NOW }).ok).toBe(false);
    }
  });

  test("a job token with an empty-string label is refused", () => {
    const t = mintJobToken(
      { tenant: "default", persona: "default", session: "S", team: "T", channel: "C", thread: "1", initiator: "U", scope: "turn", label: "" },
      { secret: KEY, now: NOW },
    );
    expect(verifyJobToken(t, { secret: KEY, now: NOW })).toEqual({ ok: false, reason: "bad_claims" });
  });
});

describe("node key configuration (gateway boot)", () => {
  test("refuses a key equal to the job secret, and keys shorter than 32 characters", () => {
    const long = "k".repeat(32);
    expect(nodeKeyViolations({ SLAUDE_NODE_KEY: long, SLAUDE_JOB_SECRET: "j".repeat(32) })).toEqual([]);
    expect(nodeKeyViolations({})).toEqual([]);
    expect(nodeKeyViolations({ SLAUDE_NODE_KEY: long, SLAUDE_JOB_SECRET: long }).join()).toContain("SLAUDE_JOB_SECRET");
    expect(nodeKeyViolations({ SLAUDE_NODE_KEY: "short" }).join()).toContain("SLAUDE_NODE_KEY");
    expect(nodeKeyViolations({ SLAUDE_NODE_KEY: long, SLAUDE_NODE_KEY_PREVIOUS: "short" }).join()).toContain("SLAUDE_NODE_KEY_PREVIOUS");
    expect(nodeKeyViolations({ SLAUDE_NODE_KEY: long, SLAUDE_NODE_KEY_PREVIOUS: "j".repeat(32), SLAUDE_JOB_SECRET: "j".repeat(32) }).join())
      .toContain("SLAUDE_NODE_KEY_PREVIOUS");
    // Messages name variables, never values.
    expect(nodeKeyViolations({ SLAUDE_NODE_KEY: long, SLAUDE_JOB_SECRET: long }).join()).not.toContain(long);
  });
});

describe("revocation", () => {
  test("a revoked id is refused when issued before revoked_before; a later credential passes", async () => {
    const before = NOW / 1000 + 10;
    const v = new NodeCredentialVerifier({ revocations: async (id) => (id === "engineering-a" ? before : null) });
    expect(await v.verify(mint(), { keys: [KEY], now: NOW + 20_000 })).toEqual({ ok: false, reason: "revoked" });
    const later = mint({}, KEY, NOW + 11_000);
    expect((await v.verify(later, { keys: [KEY], now: NOW + 20_000 })).ok).toBe(true);
    expect((await v.verify(mint({ id: "finance-a" }), { keys: [KEY], now: NOW + 20_000 })).ok).toBe(true);
  });

  test("lookups are cached for 30 s", async () => {
    let calls = 0;
    let before: number | null = null;
    const v = new NodeCredentialVerifier({ revocations: async () => (calls++, before) });
    const t = mint();
    expect((await v.verify(t, { keys: [KEY], now: NOW })).ok).toBe(true);
    before = NOW / 1000 + 1;
    expect((await v.verify(t, { keys: [KEY], now: NOW + 29_000 })).ok).toBe(true); // cached
    expect(calls).toBe(1);
    expect(await v.verify(t, { keys: [KEY], now: NOW + 31_000 })).toEqual({ ok: false, reason: "revoked" });
    expect(calls).toBe(2);
  });

  test("no revocation store (sqlite): accepted, one warning", async () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => warns.push(String(m));
    try {
      const v = new NodeCredentialVerifier({ revocations: async () => undefined });
      expect((await v.verify(mint(), { keys: [KEY], now: NOW })).ok).toBe(true);
      expect((await v.verify(mint({ id: "x-b" }), { keys: [KEY], now: NOW })).ok).toBe(true);
    } finally {
      console.warn = orig;
    }
    expect(warns.filter((w) => w.includes("revocation needs Postgres"))).toHaveLength(1);
  });

  test("store failure: fails closed without a cached answer, serves a stale one with it", async () => {
    let fail = true;
    const v = new NodeCredentialVerifier({
      revocations: async () => {
        if (fail) throw new Error("db down");
        return null;
      },
    });
    await expect(v.verify(mint(), { keys: [KEY], now: NOW })).rejects.toThrow(/db down/);
    fail = false;
    expect((await v.verify(mint(), { keys: [KEY], now: NOW })).ok).toBe(true);
    fail = true;
    expect((await v.verify(mint(), { keys: [KEY], now: NOW + 60_000 })).ok).toBe(true);
    // The stale answer is served for at most 5 minutes past the cache's expiry.
    const limit = NOW + REVOCATION_CACHE_MS + MAX_STALE_REVOCATION_MS;
    expect((await v.verify(mint(), { keys: [KEY], now: limit - 1000 })).ok).toBe(true);
    await expect(v.verify(mint(), { keys: [KEY], now: limit + 1000 })).rejects.toThrow(/db down/);
  });

  describe("node_revocations on Postgres (PGLite)", () => {
    let dbc: DbClient;
    beforeAll(async () => {
      dbc = await openDb({ dialect: "pg", driver: "pglite" });
      await runMigrations(dbc, { log: () => {} });
    });
    afterAll(async () => {
      await dbc.close();
    });

    test("revoke writes the row; the verifier refuses credentials issued before it", async () => {
      const issued = Date.now() - 60_000;
      const t = mint({ id: "pg-revoke" }, KEY, issued);
      const v = new NodeCredentialVerifier({ revocations: revocationSourceFor(dbc), cacheMs: 0 });
      expect((await v.verify(t, { keys: [KEY] })).ok).toBe(true);
      await revokeNodeCredential("pg-revoke", dbc);
      expect(await v.verify(t, { keys: [KEY] })).toEqual({ ok: false, reason: "revoked" });
      // Re-minted after the revocation: accepted.
      const fresh = mint({ id: "pg-revoke" }, KEY, Date.now() + 2000);
      expect((await v.verify(fresh, { keys: [KEY], now: Date.now() + 2000 })).ok).toBe(true);
      // Revoking again moves revoked_before forward (upsert, no conflict error).
      await revokeNodeCredential("pg-revoke", dbc);
    });
  });
});

describe("expiry gauge", () => {
  test("exports seconds to expiry per seen id, bounded", async () => {
    const v = new NodeCredentialVerifier({ revocations: async () => null });
    await v.verify(mint({ id: "gauge-a", ttlSec: 1000 }), { keys: [KEY], now: NOW });
    expect(metrics.render()).toMatch(/slaude_node_credential_expiry_seconds\{id="gauge-a"\} 1000/);
    for (let i = 0; i < MAX_GAUGED_CREDENTIALS + 5; i++) {
      await v.verify(mint({ id: `gauge-n${i}` }), { keys: [KEY], now: NOW });
    }
    const series = metrics.render().split("\n").filter((l) => l.startsWith("slaude_node_credential_expiry_seconds{"));
    expect(series.filter((l) => l.includes("gauge-")).length).toBeLessThanOrEqual(MAX_GAUGED_CREDENTIALS);
  });
});
